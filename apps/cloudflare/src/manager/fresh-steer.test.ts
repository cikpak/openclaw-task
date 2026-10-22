import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { ChatService, mapping } from '../../../backend/src/chats/service.js';
import { readPreferences } from '../../../backend/src/chats/preferences.js';
import {
  FakeGateway,
  testSettings,
} from '../../../backend/test/fake-gateway.js';
import { ManagerApplication } from './application.js';
import { ManagerAuthorization } from './authorization.js';
import type { Grant, ManagerEngine, ManagerEnv } from './types.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const f of resources.splice(0)) {
    f.service.close();
    await f.service.drain();
    f.store.close();
  }
});
async function fixture() {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service });
  const chat = await service.create({
    commandId: crypto.randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const target = mapping(store.getChat(chat.id));
  const parent = crypto.randomUUID();
  gateway.histories.get(target.sessionKey)!.activeRun = {
    id: parent,
    text: '',
    sequence: 0,
  };
  await service.reconcile();
  const grant: Grant = {
    id: 'grant',
    accountId: 'owner',
    sessionId: 'session',
    managerId: 'primary',
    expiresAt: Date.now() + 60_000,
  };
  const authorization = new ManagerAuthorization(
    {
      BACKEND: { fetch: () => Promise.resolve(Response.json({ grant })) },
    } as unknown as ManagerEnv,
    store,
  );
  authorization.claim('chat', chat.id, 'owner');
  const engine: ManagerEngine = {
    service,
    gateway,
    wake: () => Promise.resolve(),
    tick: () => Promise.resolve(),
    deadline: () => null,
  };
  const application = new ManagerApplication(
    store,
    authorization,
    engine,
    (job) => void job.catch(() => {}),
  );
  const transport = application.transport(grant);
  const send = vi.spyOn(gateway, 'send');
  const admit = (behavior?: 'queue' | 'steer', text = 'Fresh input') => {
    const command = {
      type: 'conversation.message.send' as const,
      commandId: crypto.randomUUID(),
      chatId: chat.id,
      text,
      ...(behavior ? { behavior } : {}),
    };
    return { command, accepted: transport.dispatch(command, 'test') };
  };
  const drive = async () => {
    await service.reconcile();
    await service.drain();
  };
  return {
    store,
    gateway,
    service,
    chat,
    target,
    parent,
    transport,
    send,
    admit,
    drive,
  };
}
it('ACKs a durable exact-target steer before execution, bypasses queued work and does not replay', async () => {
  const f = await fixture();
  const queue = f.admit('queue', 'Earlier queue');
  await queue.accepted;
  const steer = f.admit('steer');
  const accepted = await steer.accepted;
  expect(accepted.ok && accepted.data.receipt?.state).toBe('accepted');
  expect(JSON.stringify(accepted)).not.toContain(f.parent);
  expect(f.send).not.toHaveBeenCalled();
  expect(
    f.store.db
      .prepare(
        'SELECT target_run_id AS target FROM pending_steer_intents WHERE message_id=?',
      )
      .get(steer.command.commandId),
  ).toEqual({ target: f.parent });
  await f.drive();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]?.slice(1, 4)).toEqual([
    steer.command.commandId,
    'Fresh input',
    'steer',
  ]);
  expect(
    f.store
      .pending(f.chat.id)
      .find((item) => item.id === queue.command.commandId)?.state,
  ).toBe('pending');
  expect(await f.transport.dispatch(steer.command, 'replay')).toEqual(accepted);
  await f.drive();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('snapshots the default preference at admission and lets explicit queue override it', async () => {
  const f = await fixture();
  const preferences = readPreferences(f.store);
  preferences.busySendBehavior = 'steer';
  const save = () =>
    f.store.db
      .prepare(
        'INSERT INTO preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
      )
      .run(JSON.stringify(preferences));
  save();
  await f.admit('queue').accepted;
  const steer = f.admit();
  await steer.accepted;
  preferences.busySendBehavior = 'queue';
  save();
  await f.drive();
  expect(f.send.mock.calls.map((call) => [call[1], call[3]])).toEqual([
    [steer.command.commandId, 'steer'],
  ]);
});
it.each(['idle', 'offline'] as const)(
  'admission while %s remains queued when a later active run appears',
  async (state) => {
    const f = await fixture();
    if (state === 'idle') f.service.streams.delete(f.chat.id);
    else f.gateway.ready = false;
    const item = f.admit('steer');
    await item.accepted;
    f.gateway.ready = true;
    await f.drive();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.store.pending(f.chat.id)[0]?.state).toBe('pending');
  },
);
it.each(['different-run', 'edited', 'unknown'] as const)(
  'never auto-steers across the %s fence',
  async (fence) => {
    const f = await fixture();
    const item = f.admit('steer');
    await item.accepted;
    if (fence === 'different-run')
      f.gateway.histories.get(f.target.sessionKey)!.activeRun!.id =
        crypto.randomUUID();
    else if (fence === 'edited') {
      const pending = f.store.pending(f.chat.id)[0]!;
      pending.revision++;
      pending.text = 'Edited';
      f.store.savePending(pending);
    } else {
      const other = f.admit('queue');
      await other.accepted;
      const pending = f.store
        .pending(f.chat.id)
        .find((value) => value.id === other.command.commandId)!;
      pending.state = 'unknown';
      f.store.savePending(pending);
    }
    await f.drive();
    expect(f.send).not.toHaveBeenCalled();
  },
);
it('rechecks the captured target after asynchronous preparation and falls back to queue', async () => {
  const f = await fixture();
  const item = f.admit('steer');
  await item.accepted;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.gateway.history.bind(f.gateway);
  let reads = 0;
  vi.spyOn(f.gateway, 'history').mockImplementation(async (...args) => {
    if (++reads === 2) {
      entered();
      await held;
    }
    return original(...args);
  });
  await f.service.reconcile();
  await waiting;
  f.service.streams.set(f.chat.id, {
    id: crypto.randomUUID(),
    text: '',
    sequence: 0,
  });
  release();
  await f.service.drain();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.store.pending(f.chat.id)[0]?.state).toBe('pending');
  expect(
    f.store.db.prepare('SELECT * FROM pending_steer_intents').all(),
  ).toEqual([]);
  f.gateway.histories.get(f.target.sessionKey)!.activeRun = null;
  await f.drive();
  expect(f.send.mock.calls[0]?.[3]).toBe('queue');
});
it('cancelling an accepted pending steer removes the private intent without sending', async () => {
  const f = await fixture();
  const item = f.admit('steer');
  await item.accepted;
  const result = await f.transport.dispatch(
    {
      type: 'conversation.message.cancelQueued',
      commandId: crypto.randomUUID(),
      chatId: f.chat.id,
      messageId: item.command.commandId,
      revision: 1,
    },
    'cancel',
  );
  expect(result.ok).toBe(true);
  expect(f.store.pending(f.chat.id)).toEqual([]);
  expect(
    f.store.db.prepare('SELECT * FROM pending_steer_intents').all(),
  ).toEqual([]);
  expect(f.send).not.toHaveBeenCalled();
});
it('preserves the twenty-message queue limit before recording a steer intent', async () => {
  const f = await fixture();
  for (let index = 0; index < 20; index++)
    expect((await f.admit('queue').accepted).ok).toBe(true);
  const result = await f.admit('steer').accepted;
  expect(!result.ok && result.error.code).toBe('QUEUE_FULL');
  expect(f.store.pending(f.chat.id)).toHaveLength(20);
  expect(
    f.store.db.prepare('SELECT * FROM pending_steer_intents').all(),
  ).toEqual([]);
  expect(f.send).not.toHaveBeenCalled();
});
