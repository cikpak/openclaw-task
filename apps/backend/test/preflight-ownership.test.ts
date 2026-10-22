import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import { refresh } from '../src/chats/service-history.js';
import {
  locallyUninvoked,
  claimSubmission,
} from '../src/chats/submission-claims.js';
import { enqueue, reconcileInputs } from '../src/chats/queue.js';
const resources: { store: Store; service: ChatService; release: () => void }[] =
  [];
afterEach(async () => {
  for (const { store, service, release } of resources.splice(0)) {
    release();
    service.close();
    await service.drain();
    store.close();
  }
});

it.each(['queue', 'steer', 'reconnect'] as const)(
  'preserves exact locally uninvoked ownership across concurrent native reconciliation (%s)',
  async (kind) => {
    const store = new Store(':memory:');
    const gateway = new FakeGateway();
    const service = new ChatService(store, gateway, undefined, {
      backgroundReconciliation: false,
    });
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    resources.push({ store, service, release });
    const chat = await service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    await service.drain();
    const target = mapping(store.getChat(chat.id));
    if (kind === 'steer') {
      await service.command({
        type: 'conversation.message.send',
        commandId: randomUUID(),
        chatId: chat.id,
        text: 'Native active input',
      });
      await service.drain();
    }
    const original = gateway.history.bind(gateway);
    let held = false;
    const historyRead = vi
      .spyOn(gateway, 'history')
      .mockImplementation(async (...args) => {
        if (!held) {
          held = true;
          entered();
          await paused;
        }
        return original(...args);
      });
    const command = {
      type: 'conversation.message.send' as const,
      commandId: randomUUID(),
      chatId: chat.id,
      text: 'Durably accepted while the native scope read is paused',
      behavior: kind === 'steer' ? ('steer' as const) : ('queue' as const),
    };
    await service.command(command);
    await started;
    expect(store.submissionScope(command.commandId)).toBeNull();
    expect(historyRead).toHaveBeenCalledWith(target);
    if (kind === 'reconnect') {
      gateway.emit({ type: 'connection', ready: false });
      gateway.emit({ type: 'connection', ready: true });
    }
    await service.reconcile();
    expect(
      service.pending(chat.id).find((item) => item.id === command.commandId)
        ?.state,
    ).toBe('submitting');
    expect(
      gateway.sends.filter((send) => send.id === command.commandId),
    ).toEqual([]);
    release();
    await service.drain();
    await service.reconcile();
    await service.drain();
    expect(
      gateway.sends.filter((send) => send.id === command.commandId),
    ).toHaveLength(1);
    expect(store.submissionScope(command.commandId)).toBe(`session-${chat.id}`);
    expect(
      service.pending(chat.id).find((item) => item.id === command.commandId)
        ?.state,
    ).toBe('submitted');
    expect(gateway.sends.at(-1)?.mapping).toEqual(target);
  },
);

it('owns the uninvoked claim at the submitting publication before drive can enter submit', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service, release() {} });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const command = {
    type: 'conversation.message.send' as const,
    commandId: randomUUID(),
    chatId: chat.id,
    text: 'Atomic claim gap',
  };
  let concurrent: Promise<void> | undefined;
  let ownedAtPublication = false;
  service.onEvent((event) => {
    if (event.type !== 'conversation.snapshot' || concurrent) return;
    const item = event.snapshot.pending.find(
      (item) => item.id === command.commandId && item.state === 'submitting',
    );
    if (!item) return;
    ownedAtPublication = locallyUninvoked(service, item);
    // This read starts within changed(), before the claiming withLock resolves
    // and before its drive caller can enter submit().
    concurrent = refresh(service, chat.id);
  });
  await service.command(command);
  await concurrent;
  await service.drain();
  expect(ownedAtPublication).toBe(true);
  expect(gateway.sends.map((send) => send.id)).toEqual([command.commandId]);
  expect(service.uninvokedSubmissions.size).toBe(0);
});

it('loses only local uninvoked proof on reconstruction and conservatively retains uncertainty', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  const original = gateway.history.bind(gateway);
  vi.spyOn(gateway, 'history').mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return original(...args);
  });
  const command = {
    type: 'conversation.message.send' as const,
    commandId: randomUUID(),
    chatId: chat.id,
    text: 'Uncertain after owner loss',
  };
  await service.command(command);
  await started;
  service.close();
  release();
  await service.drain();
  const recreated = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service: recreated, release });
  expect(recreated.uninvokedSubmissions.size).toBe(0);
  await recreated.reconcile();
  await recreated.drain();
  expect(recreated.pending(chat.id)[0]).toMatchObject({
    id: command.commandId,
    state: 'unknown',
    text: command.text,
  });
  expect(gateway.sends).toEqual([]);
});

it('releases uninvoked proof before invoking and preserves post-invocation uncertainty', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service, release() {} });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  let invoked = 0;
  vi.spyOn(gateway, 'send').mockImplementation(async () => {
    invoked++;
    expect(service.uninvokedSubmissions.size).toBe(0);
    await service.reconcile();
    throw new Error('ACK lost after invocation');
  });
  const command = {
    type: 'conversation.message.send' as const,
    commandId: randomUUID(),
    chatId: chat.id,
    text: 'Native invocation outcome unknown',
  };
  await service.command(command);
  await service.drain();
  await service.reconcile();
  await service.drain();
  expect(invoked).toBe(1);
  expect(service.pending(chat.id)[0]).toMatchObject({
    id: command.commandId,
    state: 'unknown',
    text: command.text,
  });
});

it.each(['consumed', 'cancelled', 'pending', 'active'] as const)(
  'keeps authoritative native %s evidence ahead of live uninvoked proof',
  async (kind) => {
    const store = new Store(':memory:');
    const gateway = new FakeGateway();
    const service = new ChatService(store, gateway, undefined, {
      backgroundReconciliation: false,
    });
    resources.push({ store, service, release() {} });
    const chat = await service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    await service.drain();
    const item = enqueue(store, {
      type: 'conversation.message.send',
      commandId: randomUUID(),
      chatId: chat.id,
      text: 'Native authority wins',
    });
    claimSubmission(service, item);
    store.savePending(item);
    const history = await gateway.history(mapping(store.getChat(chat.id)));
    if (kind === 'active')
      history.activeRun = { id: item.submissionId, text: '', sequence: 1 };
    else
      history.receipts = [
        {
          runId: item.submissionId,
          state: kind === 'consumed' ? 'consumed' : 'pending',
          ...(kind === 'cancelled' ? { cancelled: true } : {}),
        },
      ];
    reconcileInputs(store, chat.id, history, (candidate) =>
      locallyUninvoked(service, candidate),
    );
    if (kind === 'consumed' || kind === 'cancelled')
      expect(store.pending(chat.id)).toEqual([]);
    else expect(store.pending(chat.id)[0]?.state).toBe('submitted');
  },
);
