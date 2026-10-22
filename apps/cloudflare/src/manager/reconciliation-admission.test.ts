import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { ChatService, mapping } from '../../../backend/src/chats/service.js';
import {
  FakeGateway,
  testSettings,
} from '../../../backend/test/fake-gateway.js';
import { ManagerApplication } from './application.js';
import { ManagerAuthorization } from './authorization.js';
import type { Grant, ManagerEngine, ManagerEnv } from './types.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
});

async function fixture() {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service });
  const first = await service.create({
    commandId: crypto.randomUUID(),
    settings: testSettings,
  });
  const second = await service.create({
    commandId: crypto.randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const grant: Grant = {
    id: 'grant',
    accountId: 'owner',
    sessionId: 'session',
    managerId: 'primary',
    expiresAt: Date.now() + 60_000,
  };
  const env = {
    APP_ORIGIN: 'https://messenger.example',
    BACKEND: { fetch: () => Promise.resolve(Response.json({ grant })) },
  } as unknown as ManagerEnv;
  const authorization = new ManagerAuthorization(env, store);
  for (const chat of [first, second])
    authorization.claim('chat', chat.id, grant.accountId);
  const jobs: Promise<unknown>[] = [];
  const engine: ManagerEngine = {
    service,
    gateway,
    wake: () => service.reconcile(),
    tick: () => Promise.resolve(),
    deadline: () => null,
  };
  const application = new ManagerApplication(
    store,
    authorization,
    engine,
    (job) => jobs.push(job),
  );
  const command = {
    type: 'conversation.message.send' as const,
    commandId: crypto.randomUUID(),
    chatId: first.id,
    text: 'Accepted after this chat was already reconciled',
  };
  const transport = application.transport(grant);
  return { store, gateway, service, first, second, command, jobs, transport };
}

it.each([false, true])(
  'reruns a joined reconciliation for new durable admission (new connection: %s)',
  async (reconnect) => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const secondRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.gateway.history.bind(f.gateway);
    const target = mapping(f.store.getChat(f.second.id));
    let held = false;
    vi.spyOn(f.gateway, 'history').mockImplementation(async (...args) => {
      if (args[0].sessionKey === target.sessionKey && !held) {
        held = true;
        entered();
        await paused;
      }
      return original(...args);
    });
    const pass = f.service.reconcile();
    await secondRead;
    const accepted = await f.transport.dispatch(f.command, 'test');
    expect(accepted.ok && accepted.data.receipt?.state).toBe('accepted');
    expect(f.store.pending(f.first.id)[0]?.state).toBe('pending');
    expect(f.gateway.sends).toEqual([]);
    if (reconnect) {
      f.gateway.emit({ type: 'connection', ready: false });
      f.gateway.emit({ type: 'connection', ready: true });
    }
    release();
    await pass;
    await Promise.all(f.jobs);
    await f.service.drain();
    expect(f.gateway.sends.map((send) => send.id)).toEqual([
      f.command.commandId,
    ]);
    expect(f.store.pending(f.first.id)[0]?.state).toBe('submitted');
    expect(await f.transport.dispatch(f.command, 'replay')).toEqual(accepted);
    await Promise.all(f.jobs);
    await f.service.drain();
    expect(f.gateway.sends).toHaveLength(1);
  },
);

it('honors a reconciliation request made reentrantly at pass completion', async () => {
  const f = await fixture();
  let admit!: Promise<unknown>;
  let requested = false;
  f.service.onEvent((event) => {
    if (
      event.type !== 'connection.state' ||
      event.state !== 'ready' ||
      requested
    )
      return;
    requested = true;
    admit = f.transport.dispatch(f.command, 'completion');
    // The request itself occurs synchronously inside the final publication;
    // admission may finish in the following microtasks and request another pass.
    void f.service.reconcile();
  });
  await f.service.reconcile();
  await admit;
  await Promise.all(f.jobs);
  await f.service.drain();
  expect(f.gateway.sends.map((send) => send.id)).toEqual([f.command.commandId]);
  expect(f.service.reconciliation).toBeNull();
  expect(f.service.reconciled).toBe(true);
});
