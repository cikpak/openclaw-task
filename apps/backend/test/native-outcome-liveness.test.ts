import { expect, it } from 'vitest';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { enqueue } from '../src/chats/queue.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

it('keeps durable reconciliation live when a steering owner ended before its later output is visible', async () => {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  try {
    const chat = await service.create({
      commandId: crypto.randomUUID(),
      settings: testSettings,
    });
    await service.drain();
    const target = mapping(store.getChat(chat.id));
    const item = enqueue(store, {
      type: 'conversation.message.send',
      commandId: 'steer-input',
      chatId: chat.id,
      text: 'Accepted steering work',
    });
    item.state = 'submitted';
    store.savePending(item);
    store.saveSubmissionScope(item.id, `session-${chat.id}`);
    const next = enqueue(store, {
      type: 'conversation.message.send',
      commandId: 'successor',
      chatId: chat.id,
      text: 'Fenced successor',
    });
    const history = gateway.histories.get(target.sessionKey)!;
    history.activeRun = null;
    // The owner's earlier final predates the steer; native normalization has
    // deliberately withheld completedInputs until its later result is visible.
    history.messages = [
      {
        id: 'old-owner-final',
        role: 'assistant',
        runId: 'parent-owner',
        text: 'Earlier parent result',
        createdAt: 1,
      },
    ];
    history.completedInputs = [];
    service.terminalRuns.add(`${chat.id}:parent-owner`);
    await service.reconcile();
    await service.drain();
    expect(service.pending(chat.id)[0]?.state).toBe('unknown');
    expect(service.reconciled).toBe(false);
    expect(gateway.sends).toEqual([]);
    // A subsequent existing DO-alarm pass observes the exact later native
    // successful result. No browser action or terminal event for steer-ID exists.
    history.completedInputs = [item.submissionId];
    await service.reconcile();
    await service.drain();
    expect(
      service.pending(chat.id).some((pending) => pending.id === item.id),
    ).toBe(false);
    expect(gateway.sends.map((send) => send.id)).toEqual([next.id]);
    expect(service.pending(chat.id)[0]?.state).toBe('submitted');
  } finally {
    service.close();
    await service.drain();
    store.close();
  }
});
