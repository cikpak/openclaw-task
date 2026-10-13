import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../src/auth/password.js';
import { parseConfig } from '../src/config.js';
import { Store } from '../src/database.js';
import { ChatService } from '../src/chats/service.js';
import { boundedPending } from '../src/chats/projection.js';
import { parseOutboundEvent } from '../src/outbound.js';
import { tools as readTools } from '../src/chats/tools.js';
import { projectToolEvent } from '../src/gateway/tools.js';
import { buildServer } from '../src/server.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const apps: FastifyInstance[] = [];
// Value: presentation bounds count hidden unsent and accepted inputs without evicting durable work.
it('caps mixed retained queue snapshots at 41 and counts both hidden windows', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway);
  try {
    const chat = await service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    await service.drain();
    for (let index = 0; index < 48; index++) {
      const id = randomUUID();
      store.savePending({
        id,
        chatId: chat.id,
        position: index + 1,
        text: `retained ${index}`,
        attachments: [],
        revision: 1,
        state: index < 24 ? 'pending' : 'unknown',
        submissionId: id,
        createdAt: index,
      });
    }
    gateway.ready = false;
    const projected = boundedPending(store, chat.id);
    expect(projected.pending).toHaveLength(41);
    expect(
      projected.pending.filter((item) => item.state === 'pending'),
    ).toHaveLength(20);
    expect(projected.hiddenPendingCount).toBe(7);
    expect(projected.pending.map((item) => item.position)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index + 1),
      ...Array.from({ length: 21 }, (_, index) => index + 25),
    ]);
    expect(store.pending(chat.id)).toHaveLength(48);
    const snapshot = await service.snapshot(chat.id);
    expect(snapshot.pending).toHaveLength(41);
    expect(snapshot.hiddenPendingCount).toBe(7);
    expect(() =>
      parseOutboundEvent({
        type: 'conversation.snapshot',
        generation: service.generation,
        sequence: 1,
        snapshot,
      }),
    ).not.toThrow();
  } finally {
    service.close();
    await service.drain();
    store.close();
  }
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const config = parseConfig({
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword(
      'synthetic resource acceptance password',
    ),
    SESSION_KEY: 'a'.repeat(64),
    GATEWAY_TOKEN: 'x'.repeat(32),
    APP_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_LOOPBACK: 'true',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'messenger-bounds-')),
  });
  const gateway = new FakeGateway();
  const store = new Store(':memory:');
  const server = await buildServer({ config, gateway, store });
  apps.push(server.app);
  const chat = await server.chats.create({
    commandId: randomUUID(),
    name: 'Bounded tools',
    settings: testSettings,
  });
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: config.origin },
    payload: {
      username: 'owner',
      password: 'synthetic resource acceptance password',
    },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  return { ...server, gateway, store, config, chat, cookie };
}
function emitTool(f: Awaited<ReturnType<typeof fixture>>, index: number) {
  const mapping = f.store.getChat(f.chat.id);
  const event = projectToolEvent({
    stream: 'tool',
    sessionKey: mapping.sessionKey,
    runId: 'bounded-run',
    seq: index,
    data: {
      phase: 'result',
      toolCallId: `tool-${index}`,
      name: 'read',
      args: { path: 'safe.txt', large: 'p'.repeat(8000) },
      result: 'r'.repeat(20000),
    },
  });
  if (!event)
    throw new Error('Fixture must produce a valid actual-wire tool event');
  f.gateway.emit(event);
}

it('a long upstream tool session keeps only the latest hundred bounded records in SQLite and reconnect snapshots', async () => {
  const f = await fixture();
  for (let index = 1; index <= 150; index++) emitTool(f, index);
  await vi.waitFor(() => {
    const snapshot = readTools(f.store, f.chat.id);
    expect(snapshot.at(-1)?.id).toBe('bounded-run:tool-150');
  });
  const snapshot = await f.chats.snapshot(f.chat.id);
  const tools = snapshot.tools ?? [];
  expect(tools).toHaveLength(100);
  expect(tools[0]?.id).toBe('bounded-run:tool-51');
  expect(tools.at(-1)?.id).toBe('bounded-run:tool-150');
  expect(
    tools.every(
      (tool) =>
        tool.parameters.length <= 4096 && (tool.output?.length ?? 0) <= 8192,
    ),
  ).toBe(true);
  const persisted = f.store.db
    .prepare('SELECT count(*) AS count FROM chat_tools WHERE chat_id = ?')
    .get(f.chat.id) as { count: number };
  expect(persisted.count).toBe(100);
});

it('a paused real WebSocket consumer is closed for resynchronization instead of accumulating unbounded tool output', async () => {
  const f = await fixture();
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const socket = new WebSocket(
    address.replace('http', 'ws') + '/ws/conversation',
    { headers: { cookie: f.cookie, origin: f.config.origin } },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const closed = new Promise<number>((resolve) =>
    socket.once('close', resolve),
  );
  try {
    socket.pause();
    for (let index = 1; index <= 1000; index++) emitTool(f, index);
    await vi.waitFor(
      () => {
        expect(
          [...f.app.websocketServer.clients].some(
            (peer) => peer.readyState === WebSocket.CLOSING,
          ),
        ).toBe(true);
      },
      { timeout: 10_000 },
    );
    socket.resume();
    expect(await closed).toBe(1013);
    await vi.waitFor(() =>
      expect(readTools(f.store, f.chat.id).at(-1)?.id).toBe(
        'bounded-run:tool-1000',
      ),
    );
    expect(readTools(f.store, f.chat.id)).toHaveLength(100);
  } finally {
    socket.resume();
    socket.terminate();
  }
}, 20_000);

it('the declared 32000-character message limit works over both JSON HTTP and WebSocket for multibyte text', async () => {
  const f = await fixture();
  const text = '中'.repeat(32000);
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { cookie: f.cookie, origin: f.config.origin },
    payload: {
      commandId: randomUUID(),
      name: 'Multibyte HTTP',
      settings: testSettings,
      initialMessage: { text },
    },
  });
  expect(response.statusCode).toBe(201);
  const socket = await f.app.injectWS('/ws/conversation', {
    headers: { cookie: f.cookie, origin: f.config.origin },
  });
  try {
    const commandId = randomUUID();
    const result = new Promise<{ ok: boolean }>((resolve, reject) => {
      socket.on('message', (raw) => {
        const text =
          typeof raw === 'string'
            ? raw
            : (Buffer.isBuffer(raw)
                ? raw
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw)
                  : Buffer.concat(raw)
              ).toString('utf8');
        const frame = JSON.parse(text) as {
          type: string;
          commandId?: string;
          ok: boolean;
        };
        if (frame.type === 'command.result' && frame.commandId === commandId)
          resolve(frame);
      });
      socket.once('close', (code) =>
        reject(
          new Error(`Schema-valid input was closed by transport (${code})`),
        ),
      );
    });
    socket.send(
      JSON.stringify({
        type: 'conversation.message.send',
        commandId,
        chatId: f.chat.id,
        text,
      }),
    );
    expect((await result).ok).toBe(true);
  } finally {
    socket.close();
  }
});

it('oversized HTTP bodies and WebSocket frames fail at their transport bounds without persisting input', async () => {
  const f = await fixture();
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { cookie: f.cookie, origin: f.config.origin },
    payload: {
      commandId: randomUUID(),
      name: 'Oversized input',
      settings: testSettings,
      initialMessage: { text: '\u0000'.repeat(50000) },
    },
  });
  expect(response.statusCode).toBe(413);
  expect(
    response.json<{ status: number; correlationId: string }>().status,
  ).toBe(413);
  expect(response.json<{ correlationId: string }>().correlationId).toBeTruthy();
  expect(f.store.listChats()).toHaveLength(1);
  const socket = await f.app.injectWS('/ws/conversation', {
    headers: { cookie: f.cookie, origin: f.config.origin },
  });
  const closed = new Promise<number>((resolve) =>
    socket.once('close', resolve),
  );
  socket.send(
    JSON.stringify({
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: f.chat.id,
      text: '\u0000'.repeat(50000),
    }),
  );
  expect(await closed).toBe(1009);
  expect(f.store.pending(f.chat.id)).toHaveLength(0);
});
