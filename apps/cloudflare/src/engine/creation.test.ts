import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { ChatService } from '../../../backend/src/chats/service.js';
import { AgentOperations } from '../../../backend/src/gateway/agent-operations.js';
import type { GatewayContext } from '../../../backend/src/gateway/context.js';
import {
  FakeGateway,
  testSettings,
  normalizedTestSettings,
} from '../../../backend/test/fake-gateway.js';
import { materializeChats } from './creation.js';
import { EngineDriver } from './driver.js';
import type { EngineContext } from '../manager/types.js';
import type { RecoveryCheckpoint } from './lifecycle/types.js';
import type { RecoveryDescriptor } from './recovery/types.js';
import type { PrivateContainer } from './container.js';
import type { NativeGateway } from './gateway/native.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function setup() {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  cleanup.push(() => {
    service.close();
    store.close();
  });
  const agents = new Set<string>();
  let loseAck = false;
  const request = vi.fn((method: string, params: unknown): Promise<unknown> => {
    const input = params as Record<string, string>;
    if (method === 'agents.list')
      return Promise.resolve({ agents: [...agents].map((id) => ({ id })) });
    if (method === 'agents.create') {
      if (agents.has(input.name!))
        return Promise.reject(Error('Agent already exists'));
      agents.add(input.name!);
      if (loseAck) return Promise.reject(Error('Creation ACK lost'));
      return Promise.resolve({ ok: true, agentId: input.name });
    }
    if (method === 'sessions.create')
      return Promise.resolve({ ok: true, key: input.key });
    return Promise.resolve({ ok: true });
  });
  const context = {
    agentConfigurationTail: Promise.resolve(),
    request,
    transport: { stopped: false },
    settings: () => Promise.resolve(testSettings),
    models: () => Promise.resolve([]),
  } as unknown as GatewayContext;
  const operations = new AgentOperations(context);
  const create = vi.fn((id: string, settings: typeof testSettings) =>
    operations.create(id, settings),
  );
  gateway.create = create;
  const recover = vi.fn((id: string, settings: typeof testSettings) =>
    operations.recoverCreation(id, settings),
  );
  gateway.recoverCreation = recover;
  const id = crypto.randomUUID();
  store.reserveChat({
    id,
    creationId: crypto.randomUUID(),
    name: 'Accepted chat',
    status: 'creating',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    unread: false,
    settings: testSettings,
    agentId: null,
    sessionKey: null,
  });
  return {
    id,
    create,
    recover,
    store,
    gateway,
    service,
    agents,
    request,
    set loseAck(value: boolean) {
      loseAck = value;
    },
  };
}

it('materializes a brand-new accepted chat through native create with a deterministic ID', async () => {
  const f = setup();
  await materializeChats(f.store, f.gateway, f.service);
  expect(f.create).toHaveBeenCalledExactlyOnceWith(
    f.id,
    normalizedTestSettings,
  );
  expect(f.request).toHaveBeenCalledWith('agents.create', {
    name: `messenger-${f.id}`,
    model: testSettings.model,
  });
  expect(f.request).toHaveBeenCalledWith(
    'sessions.create',
    expect.objectContaining({
      agentId: `messenger-${f.id}`,
      idempotencyKey: f.id,
    }),
  );
  expect(f.store.getChat(f.id)).toMatchObject({
    agentId: `messenger-${f.id}`,
    sessionKey: `agent:messenger-${f.id}:main`,
  });
  expect(
    f.store.db
      .prepare('SELECT state FROM native_creation_intents WHERE chat_id = ?')
      .get(f.id),
  ).toEqual({ state: 'confirmed' });
});

it('recovers a committed native agent after a lost create ACK without creating twice', async () => {
  const f = setup();
  f.loseAck = true;
  await materializeChats(f.store, f.gateway, f.service);
  expect(f.store.getChat(f.id).agentId).toBeNull();
  expect(
    f.store.db
      .prepare('SELECT state FROM native_creation_intents WHERE chat_id = ?')
      .get(f.id),
  ).toEqual({ state: 'unknown' });
  f.loseAck = false;
  const recreatedService = new ChatService(f.store, f.gateway, undefined, {
    backgroundReconciliation: false,
  });
  try {
    await materializeChats(f.store, f.gateway, recreatedService);
  } finally {
    recreatedService.close();
  }
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.store.getChat(f.id)).toMatchObject({
    agentId: `messenger-${f.id}`,
    sessionKey: `agent:messenger-${f.id}:main`,
  });
  expect(
    f.request.mock.calls.filter((call) => call[0] === 'agents.create'),
  ).toHaveLength(1);
});

it('retries a confirmed absence with the original chat ID and keeps concurrent materialization serialized', async () => {
  const f = setup();
  const create = vi
    .fn()
    .mockRejectedValueOnce(Error('Unavailable'))
    .mockImplementation((id: string, settings: typeof testSettings) => {
      expect(id).toBe(f.id);
      expect(settings).toEqual(normalizedTestSettings);
      return Promise.resolve({
        agentId: `messenger-${id}`,
        sessionKey: `agent:messenger-${id}:main`,
      });
    });
  f.gateway.create = create;
  await materializeChats(f.store, f.gateway, f.service);
  await Promise.all([
    materializeChats(f.store, f.gateway, f.service),
    materializeChats(f.store, f.gateway, f.service),
  ]);
  expect(create).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenNthCalledWith(2, f.id, normalizedTestSettings);
});

it('does not initialize while Gateway is gated and never rematerializes existing or deleting chats', async () => {
  const f = setup();
  f.gateway.ready = false;
  await materializeChats(f.store, f.gateway, f.service);
  expect(f.create).not.toHaveBeenCalled();
  f.gateway.ready = true;
  const chat = f.store.getChat(f.id);
  chat.status = 'deleting';
  f.store.saveChat(chat);
  await materializeChats(f.store, f.gateway, f.service);
  expect(f.recover).not.toHaveBeenCalled();
});

it('idempotent recovery-reference commit retains the previous valid generation', () => {
  const f = setup();
  const checkpoint = (
    generation: string,
    digest: string,
  ): RecoveryCheckpoint => {
    const object = { size: 1, sha256: digest, md5: 'AAAAAAAAAAAAAAAAAAAAAA==' };
    const descriptor: RecoveryDescriptor = {
      version: 1,
      checkpointId: generation,
      inventoryDigest: digest,
      archive: { ...object, key: `recovery/${generation}/state.tar.gz` },
      manifest: { ...object, key: `recovery/${generation}/manifest.json` },
      files: [
        {
          ...object,
          key: `files/${generation}/${digest}`,
          path: 'agents/work/documents/reply.txt',
          mode: 0o600,
          uid: 1000,
          gid: 1000,
        },
      ],
      counts: { entries: 1, userFiles: 1, databases: 0 },
    };
    return {
      generation,
      manifestKey: descriptor.manifest.key,
      manifestSha256: digest,
      descriptor: { ...descriptor },
    };
  };
  const first = checkpoint('first', 'a'.repeat(64));
  const second = checkpoint('second', 'b'.repeat(64));
  const driver = new EngineDriver(
    { store: f.store, env: {} } as unknown as EngineContext,
    {} as PrivateContainer,
    {} as NativeGateway,
    f.service,
  );
  const onCommit = vi.fn();
  driver.onCommit = onCommit;
  const commit = (value: RecoveryCheckpoint) => driver.commit(value);
  commit(first);
  commit(second);
  commit(second);
  expect(onCommit).toHaveBeenLastCalledWith(second.descriptor);
  expect(
    f.store.db
      .prepare('SELECT current, previous FROM recovery_references WHERE id = 1')
      .get(),
  ).toEqual({
    current: JSON.stringify(second),
    previous: JSON.stringify(first),
  });
});

it('does not create an orphan native agent when deletion wins during recovery lookup', async () => {
  const f = setup();
  let release!: () => void;
  const pending = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  f.gateway.recoverCreation = () => pending;
  const materializing = materializeChats(f.store, f.gateway, f.service);
  await Promise.resolve();
  await Promise.resolve();
  const chat = f.store.getChat(f.id);
  chat.status = 'deleting';
  f.store.saveChat(chat);
  release();
  await materializing;
  expect(f.create).not.toHaveBeenCalled();
  expect(f.store.getChat(f.id).agentId).toBeNull();
});
