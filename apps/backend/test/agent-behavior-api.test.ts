import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_AGENT_BEHAVIOR,
  type Preferences,
  type ChatSummary,
  type SettingsResponse,
} from '@messenger/contracts';
import { buildServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';
import { Store } from '../src/database.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const config = parseConfig({
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword('behavior test password'),
    SESSION_KEY: 'a'.repeat(64),
    GATEWAY_TOKEN: 'x'.repeat(32),
    APP_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_LOOPBACK: 'true',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'messenger-behavior-api-')),
  });
  const gateway = new FakeGateway();
  const store = new Store(':memory:');
  const f = await buildServer({ config, gateway, store });
  apps.push(f.app);
  const login = await f.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: 'behavior test password' },
  });
  const headers = {
    origin: config.origin,
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
  };
  return { ...f, gateway, store, headers };
}
const behaviorA = {
  customInstructions: 'Use practical examples.',
  responseStyle: 'concise',
  personality: 'friendly',
} as const;
const behaviorB = {
  customInstructions: 'Explain tradeoffs.',
  responseStyle: 'detailed',
  personality: 'professional',
} as const;
describe('global defaults and independent agent behavior API', () => {
  it.each(['identity', 'metadata', 'both'])(
    'retries persisted pre-upgrade %s creation without losing command reuse protection',
    async (source) => {
      const f = await fixture();
      const legacy = {
        commandId: randomUUID(),
        name: 'Legacy agent',
        settings: testSettings,
      };
      const chat = await f.chats.create(legacy);
      if (source !== 'metadata')
        f.store.db
          .prepare('UPDATE creation_commands SET json = ? WHERE id = ?')
          .run(JSON.stringify(legacy), legacy.commandId);
      if (source !== 'identity')
        f.store.saveMetadata(chat.id, {
          ...f.store.metadata(chat.id),
          creationInput: legacy,
        });
      const retried = await f.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: f.headers,
        payload: legacy,
      });
      expect(retried.statusCode).toBe(201);
      expect(retried.json<ChatSummary>().id).toBe(chat.id);
      const changed = await f.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers: f.headers,
        payload: {
          ...legacy,
          settings: {
            ...testSettings,
            customInstructions: 'Actually different.',
          },
        },
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json<{ code: string }>().code).toBe('COMMAND_ID_REUSED');
    },
  );
  it('recovers a failed pre-upgrade creation using normalized identity and metadata', async () => {
    const f = await fixture();
    const legacy = { commandId: randomUUID(), settings: testSettings };
    f.gateway.failCreation = true;
    await expect(f.chats.create(legacy)).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
    });
    const persisted = f.store.findCreation(legacy.commandId);
    if (!persisted) throw new Error('Failed creation must retain its identity');
    expect(persisted.status).toBe('recovery');
    f.store.db
      .prepare('UPDATE creation_commands SET json = ? WHERE id = ?')
      .run(JSON.stringify(legacy), legacy.commandId);
    f.store.saveMetadata(persisted.id, {
      ...f.store.metadata(persisted.id),
      creationInput: legacy,
    });
    f.gateway.failCreation = false;
    const recovered = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload: legacy,
    });
    expect(recovered.statusCode).toBe(201);
    expect(recovered.json<ChatSummary>().id).toBe(persisted.id);
    expect(recovered.json<ChatSummary>().status).toBe('idle');
    expect(f.store.listChats()).toHaveLength(1);
  });
  it('copies global values on creation, persists changes, and does not modify existing agents', async () => {
    const f = await fixture();
    const firstPreferences = await f.app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { ...f.headers, 'if-match': '"1"' },
      payload: {
        defaults: { ...testSettings, ...behaviorA },
        busySendBehavior: 'queue',
      },
    });
    expect(firstPreferences.statusCode).toBe(200);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload: {
        commandId: randomUUID(),
        settings: firstPreferences.json<Preferences>().defaults,
      },
    });
    expect(created.statusCode).toBe(201);
    const chat = created.json<ChatSummary>();
    const secondPreferences = await f.app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: {
        ...f.headers,
        'if-match': firstPreferences.headers.etag ?? '',
      },
      payload: {
        defaults: { ...testSettings, ...behaviorB },
        busySendBehavior: 'queue',
      },
    });
    expect(secondPreferences.statusCode).toBe(200);
    const second = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload: {
        commandId: randomUUID(),
        settings: secondPreferences.json<Preferences>().defaults,
      },
    });
    expect(second.json<ChatSummary>().settings).toEqual({
      ...testSettings,
      ...behaviorB,
    });
    expect(f.store.getChat(chat.id).settings).toEqual({
      ...testSettings,
      ...behaviorA,
    });
    const latest = await f.app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/settings`,
      headers: f.headers,
    });
    const saved = await f.app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}/settings`,
      headers: { ...f.headers, 'if-match': latest.headers.etag ?? '' },
      payload: {
        settings: { ...testSettings, ...behaviorB, personality: 'direct' },
        policy: 'when-idle',
      },
    });
    expect(saved.statusCode).toBe(202);
    await f.chats.drain();
    expect(f.store.getChat(chat.id).settings).toEqual({
      ...testSettings,
      ...behaviorB,
      personality: 'direct',
    });
    expect(f.store.getChat(second.json<ChatSummary>().id).settings).toEqual({
      ...testSettings,
      ...behaviorB,
    });
    expect(f.chats.preferences().defaults).toEqual({
      ...testSettings,
      ...behaviorB,
    });
    const reloaded = await f.app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/settings`,
      headers: f.headers,
    });
    expect(reloaded.json<SettingsResponse>().effective).toEqual(
      f.store.getChat(chat.id).settings,
    );
    expect(f.store.settingsOperation(chat.id)).toBeNull();
  });
  it('normalizes legacy explicit creation/settings requests and rejects invalid behavior payloads', async () => {
    const f = await fixture();
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: f.headers,
      payload: { commandId: randomUUID(), settings: testSettings },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<ChatSummary>().settings).toEqual({
      ...testSettings,
      ...DEFAULT_AGENT_BEHAVIOR,
    });
    for (const invalid of [
      { customInstructions: 'x'.repeat(8001) },
      { responseStyle: 'invented' },
      { personality: 'invented' },
    ]) {
      const result = await f.app.inject({
        method: 'PATCH',
        url: '/api/preferences',
        headers: { ...f.headers, 'if-match': '"1"' },
        payload: {
          defaults: { ...testSettings, ...invalid },
          busySendBehavior: 'queue',
        },
      });
      expect(result.statusCode).toBe(400);
    }
  });
  it('retains uncertain settings for recovery without modifying another agent', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: { ...testSettings, ...behaviorA },
    });
    const other = await f.chats.create({
      commandId: randomUUID(),
      settings: { ...testSettings, ...behaviorB },
    });
    f.gateway.failSettings = true;
    await f.chats.updateSettings(
      chat.id,
      { ...testSettings, ...behaviorB },
      'when-idle',
      `"${chat.version}"`,
    );
    await f.chats.drain();
    expect(f.store.settingsOperation(chat.id)?.status).toBe('unknown');
    expect(f.store.getChat(chat.id).settings).toEqual({
      ...testSettings,
      ...behaviorA,
    });
    expect(f.store.getChat(other.id).settings).toEqual({
      ...testSettings,
      ...behaviorB,
    });
  });
});
