import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { handleGatewayEvent } from '../src/chats/service-events.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
});

it.each(['final', 'aborted', 'error'] as const)(
  'retains accepted text after %s without an authoritative input receipt',
  async (state) => {
    const store = new Store(':memory:');
    const gateway = new FakeGateway();
    const service = new ChatService(store, gateway, undefined, {
      backgroundReconciliation: false,
    });
    resources.push({ store, service });
    const chat = await service.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const target = mapping(store.getChat(chat.id));
    const first = {
      type: 'conversation.message.send' as const,
      commandId: randomUUID(),
      chatId: chat.id,
      text: 'Accepted text interrupted before native journal proof',
    };
    const next = {
      ...first,
      commandId: randomUUID(),
      text: 'Queued successor',
    };
    await service.command(first);
    await service.drain();
    await service.command(next);
    const history = gateway.histories.get(target.sessionKey)!;
    history.messages = [];
    history.activeRun = null;
    history.receipts = [];
    const read = vi.spyOn(gateway, 'history');
    read.mockRejectedValueOnce(
      new Error('Gateway stopped during terminal read'),
    );
    await expect(
      handleGatewayEvent(service, {
        type: 'chat',
        sessionKey: target.sessionKey,
        runId: first.commandId,
        sequence: 10,
        state,
        text: '',
        replace: true,
      }),
    ).rejects.toThrow('Gateway stopped');
    await service.drain();
    expect(service.cachedSnapshot(chat.id).pending).toMatchObject([
      { id: first.commandId, text: first.text, state: 'unknown' },
      { id: next.commandId, text: next.text, state: 'pending' },
    ]);
    expect(store.getChat(chat.id).status).toBe('recovery');
    await service.reconcile();
    await service.drain();
    expect(gateway.sends.map((send) => send.id)).toEqual([first.commandId]);
    expect(service.pending(chat.id)[0]?.state).toBe('unknown');
    // Only an exact authoritative receipt releases the successor; never replay
    // the interrupted input merely because the native transcript is empty.
    history.receipts = [{ runId: first.commandId, state: 'consumed' }];
    await service.reconcile();
    await service.drain();
    expect(gateway.sends.map((send) => send.id)).toEqual([
      first.commandId,
      next.commandId,
    ]);
    expect(service.pending(chat.id).map((item) => item.id)).toEqual([
      next.commandId,
    ]);
  },
);

it('keeps durable reconciliation scheduled while a terminal receipt is still pending', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  resources.push({ store, service });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  const target = mapping(store.getChat(chat.id));
  const first = {
    type: 'conversation.message.send' as const,
    commandId: randomUUID(),
    chatId: chat.id,
    text: 'Native receipt cleanup is delayed',
  };
  const next = {
    ...first,
    commandId: randomUUID(),
    text: 'Wait for consumed proof',
  };
  await service.command(first);
  await service.drain();
  await service.command(next);
  const history = gateway.histories.get(target.sessionKey)!;
  history.activeRun = null;
  await handleGatewayEvent(service, {
    type: 'chat',
    sessionKey: target.sessionKey,
    runId: first.commandId,
    sequence: 10,
    state: 'final',
    text: '',
    replace: true,
  });
  await service.drain();
  await service.reconcile();
  await service.drain();
  expect(service.reconciled).toBe(false);
  expect(service.pending(chat.id)[0]?.state).toBe('submitted');
  expect(gateway.sends.map((send) => send.id)).toEqual([first.commandId]);
  history.receipts[0]!.state = 'consumed';
  await service.reconcile();
  await service.drain();
  expect(service.reconciled).toBe(true);
  expect(gateway.sends.map((send) => send.id)).toEqual([
    first.commandId,
    next.commandId,
  ]);
});
