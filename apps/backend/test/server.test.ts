import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationResult, ModelCapability } from '@messenger/contracts';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { Store } from '../src/database.js';
import {
  FakeGateway,
  normalizedTestSettings,
  testSettings,
} from './fake-gateway.js';
import { ApplicationError, toProblem } from '../src/errors.js';
import { resultSchema } from '../src/schemas.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(lifetime = 86400, trustProxyHops: '0' | '1' = '0') {
  const config = parseConfig({
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword('correct horse battery staple'),
    SESSION_KEY: 'a'.repeat(64),
    GATEWAY_TOKEN: 'x'.repeat(32),
    APP_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_LOOPBACK: 'true',
    SESSION_LIFETIME_SECONDS: String(lifetime),
    TRUST_PROXY_HOPS: trustProxyHops,
    DATA_DIR: mkdtempSync(join(tmpdir(), 'messenger-test-')),
  });
  const gateway = new FakeGateway();
  const store = new Store(':memory:');
  const server = await buildServer({ config, gateway, store });
  apps.push(server.app);
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: 'correct horse battery staple' },
  });
  const setCookie = login.headers['set-cookie'];
  const cookie =
    String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ??
    '';
  return {
    ...server,
    config,
    gateway,
    cookie,
    headers: { cookie, origin: config.origin },
  };
}
describe('authentication and transport contracts', () => {
  // Value card: HTTP serialization must retain verified tri-state support without
  // inventing capability data for legacy catalogs; covers global and chat scopes.
  it.each(['global', 'chat'] as const)(
    'preserves fast-mode support states and legacy omission in %s model responses',
    async (scope) => {
      const f = await fixture();
      const chat =
        scope === 'chat'
          ? await f.chats.create({
              commandId: randomUUID(),
              settings: testSettings,
            })
          : null;
      const base = {
        name: 'Test model',
        provider: 'test',
        available: true,
        thinkingLevels: [{ id: 'off', label: 'Off' }],
        thinkingDefault: 'off',
        input: ['text'],
      };
      const catalog: ModelCapability[] = [
        {
          ...base,
          id: 'test/supported',
          supportsFastMode: true,
          fastModeSupport: 'supported',
        },
        {
          ...base,
          id: 'test/unsupported',
          supportsFastMode: false,
          fastModeSupport: 'unsupported',
        },
        {
          ...base,
          id: 'test/unknown',
          supportsFastMode: false,
          fastModeSupport: 'unknown',
        },
        { ...base, id: 'test/legacy', supportsFastMode: true },
      ];
      const models = vi.spyOn(f.gateway, 'models').mockResolvedValue(catalog);
      const response = await f.app.inject({
        url: chat ? `/api/models?chatId=${chat.id}` : '/api/models',
        headers: f.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        models: [
          {
            id: 'test/supported',
            supportsFastMode: true,
            fastModeSupport: 'supported',
          },
          {
            id: 'test/unsupported',
            supportsFastMode: false,
            fastModeSupport: 'unsupported',
          },
          {
            id: 'test/unknown',
            supportsFastMode: false,
            fastModeSupport: 'unknown',
          },
          { id: 'test/legacy', supportsFastMode: true },
        ],
      });
      expect(
        response.json<{ models: ModelCapability[] }>().models[3],
      ).not.toHaveProperty('fastModeSupport');
      expect(models).toHaveBeenCalledExactlyOnceWith(
        chat
          ? {
              agentId: `agent-${chat.id}`,
              sessionKey: `agent:${chat.id}:main`,
            }
          : undefined,
      );
    },
  );
  // Value card: malformed upstream capability data must fail the HTTP response
  // as an internal error without exposing model details to the browser.
  it('rejects invalid fast-mode support in model responses without leaking upstream data', async () => {
    const f = await fixture();
    vi.spyOn(f.gateway, 'models').mockResolvedValueOnce([
      {
        id: 'private-invalid-fast-mode-model',
        name: 'Test model',
        provider: 'test',
        available: true,
        thinkingLevels: [{ id: 'off', label: 'Off' }],
        thinkingDefault: 'off',
        supportsFastMode: false,
        fastModeSupport: 'private-invalid-support',
        input: ['text'],
      },
    ] as unknown as ModelCapability[]);
    const response = await f.app.inject({
      url: '/api/models',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
    expect(response.body).not.toContain('private-invalid-fast-mode-model');
    expect(response.body).not.toContain('private-invalid-support');
  });
  it('treats raw upstream Zod failures as internal errors while route body, query and params validation stay client errors', async () => {
    const f = await fixture();
    vi.spyOn(f.gateway, 'models').mockImplementationOnce(
      () =>
        Promise.resolve(
          z
            .array(z.object({ id: z.string() }))
            .parse([{ id: { secret: 'private-upstream-data' } }]),
        ) as ReturnType<FakeGateway['models']>,
    );
    const internal = await f.app.inject({
      url: '/api/models',
      headers: f.headers,
    });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 500,
    });
    expect(internal.body).not.toContain('private-upstream-data');
    for (const request of [
      {
        method: 'POST' as const,
        url: '/api/chats',
        payload: { commandId: randomUUID(), settings: { model: 123 } },
      },
      { method: 'GET' as const, url: '/api/models?chatId=not-a-uuid' },
      { method: 'GET' as const, url: '/api/chats/not-a-uuid' },
    ]) {
      const response = await f.app.inject({ ...request, headers: f.headers });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'INVALID_REQUEST',
        status: 400,
      });
    }
  });
  it('closes a socket with an actionable internal failure instead of transmitting a malformed result', async () => {
    const f = await fixture();
    vi.spyOn(f.chats, 'command').mockResolvedValueOnce({
      type: 'command.result',
      commandId: randomUUID(),
      ok: true,
      data: { snapshot: { secretInternalField: 'must-not-leak' } },
    } as unknown as ConversationResult);
    const socket = await f.app.injectWS('/ws/conversation', {
      headers: f.headers,
    });
    const received: string[] = [];
    socket.on('message', (raw) => {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      received.push(bytes.toString('utf8'));
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    socket.send(
      JSON.stringify({
        type: 'conversation.snapshot.request',
        commandId: randomUUID(),
      }),
    );
    expect(await closed).toEqual({
      code: 1011,
      reason: 'Reconnect to refresh',
    });
    expect(received.every((raw) => !raw.includes('must-not-leak'))).toBe(true);
    expect(received.some((raw) => raw.includes('command.result'))).toBe(false);
  });
  it('reports invalid REST model projections as internal serialization errors, never invalid client requests', async () => {
    const f = await fixture();
    vi.spyOn(f.gateway, 'models').mockResolvedValueOnce([
      { id: 'private-invalid-model' },
    ] as unknown as Awaited<ReturnType<FakeGateway['models']>>);
    const response = await f.app.inject({
      url: '/api/models',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json<{ code: string }>()).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(response.body).not.toContain('private-invalid-model');
    expect((await f.app.inject('/ready')).json()).toEqual({ status: 'ready' });
    f.gateway.ready = false;
    expect((await f.app.inject('/ready')).json()).toEqual({
      status: 'initializing',
    });
  });
  it('limits each Caddy-forwarded browser independently instead of locking out every browser', async () => {
    const f = await fixture(86400, '1');
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/session',
        remoteAddress: '172.18.0.2',
        headers: {
          origin: f.config.origin,
          'x-forwarded-for': '198.51.100.10',
        },
        payload: { username: 'owner', password: 'incorrect' },
      });
      expect(response.statusCode).toBe(401);
    }
    const owner = await f.app.inject({
      method: 'POST',
      url: '/api/session',
      remoteAddress: '172.18.0.2',
      headers: { origin: f.config.origin, 'x-forwarded-for': '198.51.100.20' },
      payload: { username: 'owner', password: 'correct horse battery staple' },
    });
    expect(owner.statusCode).toBe(200);
  });
  it('ignores spoofed addresses before the single trusted proxy hop when counting login attempts', async () => {
    const f = await fixture(86400, '1');
    for (let attempt = 0; attempt < 6; attempt++) {
      // Caddy defaults replace untrusted incoming forwarding headers with the peer address.
      // A longer chain is also safe: only the closest forwarded browser is counted.
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/session',
        remoteAddress: '172.18.0.2',
        headers: {
          origin: f.config.origin,
          'x-forwarded-for': `203.0.113.${attempt + 1}, 198.51.100.10`,
        },
        payload: { username: 'owner', password: 'incorrect' },
      });
      expect(response.statusCode).toBe(attempt === 5 ? 429 : 401);
    }
  });
  it('trusts no forwarding headers in direct development mode', async () => {
    const f = await fixture();
    expect(f.config.trustProxyHops).toBe(0);
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/session',
        remoteAddress: '198.51.100.10',
        headers: {
          origin: f.config.origin,
          'x-forwarded-for': `203.0.113.${attempt + 1}`,
        },
        payload: { username: 'owner', password: 'incorrect' },
      });
      expect(response.statusCode).toBe(attempt === 5 ? 429 : 401);
    }
  });
  it('hashes with salted scrypt and rejects incorrect credentials', async () => {
    const hash = await hashPassword('passphrase');
    expect(await verifyPassword('passphrase', hash)).toBe(true);
    expect(await verifyPassword('incorrect', hash)).toBe(false);
  });
  it('keeps liveness available while dependency readiness reports unavailable', async () => {
    const f = await fixture();
    f.gateway.ready = false;
    expect((await f.app.inject('/health')).statusCode).toBe(200);
    expect((await f.app.inject('/ready')).statusCode).toBe(503);
  });
  it('requires sessions and rejects cross-origin mutations', async () => {
    const f = await fixture();
    const unauthorized = await f.app.inject('/api/chats');
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json<{ status: number }>().status).toBe(401);
    const csrf = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { cookie: f.cookie, origin: 'https://evil.example' },
      payload: {},
    });
    expect(csrf.statusCode).toBe(403);
  });
  it('revokes cookies and open sockets on logout', async () => {
    const f = await fixture();
    const socket = await f.app.injectWS('/ws/conversation', {
      headers: f.headers,
    });
    const close = new Promise<number>((resolve) => socket.on('close', resolve));
    const response = await f.app.inject({
      method: 'DELETE',
      url: '/api/session',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(await close).toBe(1008);
    expect(
      (await f.app.inject({ url: '/api/chats', headers: f.headers }))
        .statusCode,
    ).toBe(401);
  });
  it('returns generic errors for malformed commands and handles session expiry on a socket', async () => {
    const f = await fixture(1);
    const socket = await f.app.injectWS('/ws/conversation', {
      headers: f.headers,
    });
    const message = new Promise<string>((resolve) =>
      socket.once('message', (raw) => {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        resolve(bytes.toString('utf8'));
      }),
    );
    socket.send('{');
    const result = resultSchema.parse(JSON.parse(await message));
    expect(result.ok).toBe(false);
    const close = new Promise<number>((resolve) => socket.on('close', resolve));
    expect(await close).toBe(1008);
  });
});
describe('chat creation and durable intent', () => {
  it('enforces ETag preconditions on lifecycle, preferences and settings routes', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const missing = await f.app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}`,
      headers: f.headers,
      payload: { name: 'Renamed' },
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json<{ status: number }>().status).toBe(428);
    const stale = await f.app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}`,
      headers: { ...f.headers, 'if-match': '"0"' },
      payload: { name: 'Renamed' },
    });
    expect(stale.statusCode).toBe(412);
    const renamed = await f.app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}`,
      headers: { ...f.headers, 'if-match': `"${chat.version}"` },
      payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.headers.etag).toBe('"2"');
    const preferences = await f.app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { ...f.headers, 'if-match': '"1"' },
      payload: { busySendBehavior: 'steer', defaults: testSettings },
    });
    expect(preferences.statusCode).toBe(200);
    expect(preferences.headers.etag).toBe('"2"');
    expect(f.chats.preferences().busySendBehavior).toBe('steer');
    const settings = await f.app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}/settings`,
      headers: { ...f.headers, 'if-match': '"2"' },
      payload: {
        settings: { ...testSettings, fastMode: true },
        policy: 'when-idle',
      },
    });
    expect(settings.statusCode).toBe(202);
    await f.chats.drain();
    const effective = await f.app.inject({
      url: `/api/chats/${chat.id}/settings`,
      headers: f.headers,
    });
    expect(effective.statusCode).toBe(200);
    expect(
      effective.json<{ effective: { fastMode: boolean }; pending: unknown }>(),
    ).toMatchObject({ effective: { fastMode: true }, pending: null });
    const deleted = await f.app.inject({
      method: 'DELETE',
      url: `/api/chats/${chat.id}`,
      headers: {
        ...f.headers,
        'if-match': `"${f.store.getChat(chat.id).version}"`,
      },
    });
    expect(deleted.statusCode).toBe(202);
    await f.chats.drain();
    expect(
      (await f.app.inject({ url: `/api/chats/${chat.id}`, headers: f.headers }))
        .statusCode,
    ).toBe(404);
  });
  it('maps only trusted Fastify body parser failures to safe consistent HTTP errors', async () => {
    const f = await fixture();
    const invalid = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: '{',
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ status: number; code: string }>()).toMatchObject({
      status: 400,
      code: 'INVALID_JSON',
    });
    const empty = await f.app.inject({
      method: 'DELETE',
      url: '/api/session',
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ status: number }>().status).toBe(400);
    const tooLarge = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { ...f.headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ value: 'x'.repeat(262145) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json<{ status: number }>().status).toBe(413);
    const unsupported = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { ...f.headers, 'content-type': 'application/x-unknown' },
      payload: 'not supported',
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json<{ status: number }>().status).toBe(415);
  });
  it('creates one mapped chat with settings read-back and avoids duplicate creation', async () => {
    const f = await fixture();
    const commandId = randomUUID();
    const payload = { commandId, settings: testSettings };
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json<{ id: string; settings: unknown }>();
    expect(created.headers.location).toBe(`/api/chats/${chat.id}`);
    expect(chat.settings).toEqual(normalizedTestSettings);
    const duplicate = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload,
    });
    expect(duplicate.json<{ id: string }>().id).toBe(chat.id);
    expect(f.store.listChats()).toHaveLength(1);
    expect(JSON.stringify(chat)).not.toContain('agentId');
  });
  it('reserves capacity atomically and retains uncertain creation reservations', async () => {
    const f = await fixture();
    f.gateway.failCreation = true;
    const responses = await Promise.all(
      Array.from({ length: 11 }, () =>
        f.app.inject({
          method: 'POST',
          url: '/api/chats',
          headers: f.headers,
          payload: { commandId: randomUUID(), settings: testSettings },
        }),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(1);
    expect(f.store.listChats()).toHaveLength(10);
    expect(responses[0]?.body).not.toContain('secret upstream error');
  });
  it('rejects stale model capabilities without consuming capacity', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload: {
        commandId: randomUUID(),
        settings: { ...testSettings, model: 'unknown/model' },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(f.store.listChats()).toHaveLength(0);
  });
  it('persists an uncertain submission and never resends duplicate commands', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    f.gateway.failSend = true;
    const command = {
      type: 'conversation.message.send' as const,
      commandId: randomUUID(),
      chatId: chat.id,
      text: 'retained content',
    };
    const first = await f.chats.command(command);
    expect(first.ok).toBe(true);
    expect(await f.chats.command(command)).toEqual(first);
    // A command ACK proves durable acceptance, not completion of asynchronous dispatch.
    await f.chats.drain();
    expect(f.gateway.sends).toHaveLength(1);
    expect(f.chats.pending(chat.id)[0]?.state).toBe('unknown');
    expect(f.chats.pending(chat.id)[0]?.text).toBe('retained content');
  });
  it('streams append and replacement updates without leaking between chats', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const other = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const target = f.store.getChat(chat.id);
    const events: unknown[] = [];
    f.chats.onEvent((event) => events.push(event));
    f.gateway.emit({
      type: 'chat',
      sessionKey: target.sessionKey ?? '',
      runId: 'run',
      sequence: 1,
      state: 'delta',
      text: 'hello',
      replace: false,
    });
    f.gateway.emit({
      type: 'chat',
      sessionKey: target.sessionKey ?? '',
      runId: 'run',
      sequence: 2,
      state: 'delta',
      text: 'updated',
      replace: true,
    });
    expect((await f.chats.snapshot(chat.id)).activeRun?.text).toBe('updated');
    expect((await f.chats.snapshot(other.id)).activeRun).toBeNull();
    expect(events).toHaveLength(2);
  });
  it('validates safe error conversion and persisted SQLite sessions', () => {
    const store = new Store(':memory:');
    store.createSession('session', 100);
    expect(store.sessionValid('session', 99)).toBe(true);
    store.revokeSession('session');
    expect(store.sessionValid('session', 99)).toBe(false);
    expect(
      toProblem(new Error('secret SQL'), 'correlation').detail,
    ).not.toContain('SQL');
    expect(
      toProblem(
        new ApplicationError(412, 'STALE_VERSION', 'Reload to continue.'),
        'correlation',
      ).status,
    ).toBe(412);
    store.close();
  });
  it('discards transient streams on reconnect and never marks an obsolete connection ready', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const target = f.store.getChat(chat.id);
    const sessionKey = target.sessionKey ?? '';
    f.gateway.emit({
      type: 'chat',
      sessionKey,
      runId: 'old',
      sequence: 1,
      state: 'delta',
      text: 'stale output',
      replace: false,
    });
    expect((await f.chats.snapshot(chat.id)).activeRun?.text).toBe(
      'stale output',
    );
    f.gateway.ready = false;
    f.gateway.emit({ type: 'connection', ready: false });
    expect((await f.chats.snapshot(chat.id)).activeRun).toBeNull();
    const authoritative = await f.gateway.history({
      agentId: target.agentId ?? '',
      sessionKey,
    });
    let finish!: (value: typeof authoritative) => void;
    const original = f.gateway.history.bind(f.gateway);
    f.gateway.history = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const states: unknown[] = [];
    f.chats.onEvent((event) => {
      if (event.type === 'connection.state') states.push(event.state);
    });
    f.gateway.ready = true;
    f.gateway.emit({ type: 'connection', ready: true });
    f.gateway.ready = false;
    f.gateway.emit({ type: 'connection', ready: false });
    finish(authoritative);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.chats.reconciled).toBe(false);
    expect(states).toEqual(['unavailable']);
    f.gateway.history = original;
  });
  it('retains the authoritative streamed prefix when reconnecting during a run', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const target = f.store.getChat(chat.id);
    const sessionKey = target.sessionKey ?? '';
    const history = await f.gateway.history({
      agentId: target.agentId ?? '',
      sessionKey,
    });
    history.activeRun = { id: 'run', text: 'hello ', sequence: 0 };
    await f.chats.reconcile();
    f.gateway.emit({
      type: 'chat',
      sessionKey,
      runId: 'run',
      sequence: 1,
      state: 'delta',
      text: 'world',
      replace: false,
    });
    expect((await f.chats.snapshot(chat.id)).activeRun?.text).toBe(
      'hello world',
    );
  });
});
