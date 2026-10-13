import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Attachment } from '@messenger/contracts';
import { buildServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';
import { Store } from '../src/database.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import { sharedFiles } from '../src/uploads/shared-files.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const config = parseConfig({
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword('password'),
    SESSION_KEY: 'a'.repeat(64),
    GATEWAY_TOKEN: 'x'.repeat(32),
    APP_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_LOOPBACK: 'true',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'shared-http-')),
  });
  const gateway = new FakeGateway();
  const store = new Store(':memory:');
  const server = await buildServer({ config, gateway, store });
  apps.push(server.app);
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: 'password' },
  });
  const headers = {
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    origin: config.origin,
  };
  const chat = await server.chats.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  const boundary = 'shared-fixture';
  const bytes = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nFixture\r\n--${boundary}--\r\n`,
  );
  const upload = await server.app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      ...headers,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: bytes,
  });
  expect(upload.statusCode).toBe(201);
  const file = upload.json<Attachment>();
  return { ...server, config, gateway, headers, chat, file };
}
it('requires authentication, scopes catalog, validates metadata and retains successful shares after terminal completion', async () => {
  const f = await fixture();
  const url = `/api/chats/${f.chat.id}/shared-files`;
  expect((await f.app.inject({ url })).statusCode).toBe(401);
  const id = randomUUID();
  await f.chats.command({
    type: 'conversation.message.send',
    commandId: id,
    chatId: f.chat.id,
    text: 'With file',
    uploadIds: [f.file.uploadId],
  });
  await f.chats.drain();
  const response = await f.app.inject({ url, headers: f.headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.json()).toEqual({ files: [f.file] });
  expect(response.body).not.toContain('download');
  const target = {
    agentId: f.store.getChat(f.chat.id).agentId!,
    sessionKey: f.store.getChat(f.chat.id).sessionKey!,
  };
  f.gateway.complete(target, id, 2);
  await vi.waitFor(() => expect(f.store.pending(f.chat.id)).toEqual([]));
  expect((await f.app.inject({ url, headers: f.headers })).json()).toEqual({
    files: [f.file],
  });
  const other = await f.chats.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  expect(
    (
      await f.app.inject({
        url: `/api/chats/${other.id}/shared-files`,
        headers: f.headers,
      })
    ).json(),
  ).toEqual({ files: [] });
  expect(
    (
      await f.app.inject({
        url: `/api/chats/${randomUUID()}/shared-files`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await f.app.inject({
        url: '/api/chats/not-a-uuid/shared-files',
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  const row = f.store.getChat(f.chat.id);
  row.status = 'deleting';
  f.store.saveChat(row);
  expect((await f.app.inject({ url, headers: f.headers })).statusCode).toBe(
    404,
  );
});
it('records creation initial attachments without guessing a legacy association', async () => {
  const f = await fixture();
  const initial = await f.chats.create({
    commandId: randomUUID(),
    settings: testSettings,
    initialMessage: { text: 'First', uploadIds: [f.file.uploadId] },
  });
  await f.chats.drain();
  expect(await sharedFiles(f.store, f.gateway, 'owner', initial.id)).toEqual([
    f.file,
  ]);
});
it('excludes queued files canceled before dispatch without changing upload retention', async () => {
  const f = await fixture();
  await f.chats.command({
    type: 'conversation.message.send',
    commandId: randomUUID(),
    chatId: f.chat.id,
    text: 'Active',
  });
  await f.chats.drain();
  const queued = randomUUID();
  await f.chats.command({
    type: 'conversation.message.send',
    commandId: queued,
    chatId: f.chat.id,
    text: 'Queued',
    uploadIds: [f.file.uploadId],
  });
  await f.chats.command({
    type: 'conversation.message.cancelQueued',
    commandId: randomUUID(),
    chatId: f.chat.id,
    messageId: queued,
    revision: 1,
  });
  expect(
    (
      await f.app.inject({
        url: `/api/chats/${f.chat.id}/shared-files`,
        headers: f.headers,
      })
    ).json(),
  ).toEqual({ files: [] });
  expect(
    f.store.db
      .prepare('SELECT id FROM uploads WHERE id=?')
      .get(f.file.uploadId),
  ).toEqual({ id: f.file.uploadId });
});
