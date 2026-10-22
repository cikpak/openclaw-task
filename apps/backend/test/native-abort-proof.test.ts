import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import { enqueue, reconcileInputs } from '../src/chats/queue.js';
import { abortAcceptedInputs } from '../src/chats/cancellations.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
});
async function fixture(owner = 'input') {
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
  const input = enqueue(store, {
    type: 'conversation.message.send',
    commandId: 'input',
    chatId: chat.id,
    text: 'Exact accepted input',
  });
  input.state = 'submitted';
  store.savePending(input);
  const history = gateway.histories.get(
    mapping(store.getChat(chat.id)).sessionKey,
  )!;
  store.saveSubmissionScope(input.id, history.sessionId!);
  history.activeRun = { id: owner, text: '', sequence: 1 };
  history.receipts = [];
  Object.assign(history, {
    nativeInputOwners: [{ inputId: input.submissionId, runId: owner }],
  });
  Object.assign(gateway, { nativeAbortProofs: true });
  return { store, gateway, service, chat, input, history };
}

it.each(['input', 'parent'])(
  'settles only an exact scoped confirmed app abort, including owner %s',
  async (owner) => {
    const f = await fixture(owner);
    Object.assign(f.gateway, {
      abort: () => {
        f.history.activeRun = null;
        return { abortedRunId: owner };
      },
    });
    expect(
      await f.service.command({
        type: 'conversation.run.abort',
        commandId: crypto.randomUUID(),
        chatId: f.chat.id,
      }),
    ).toMatchObject({ ok: true });
    expect(f.store.pending(f.chat.id)).toEqual([]);
    expect(f.gateway.sends).toEqual([]);
  },
);

it.each(['no-active', 'wrong-owner', 'lost-ack', 'reset', 'restart-cancelled'])(
  'retains uncertainty for %s without replay',
  async (failure) => {
    const f = await fixture();
    Object.assign(f.gateway, {
      abort: () => {
        f.history.activeRun = null;
        if (failure === 'reset') f.history.sessionId = 'reset-session';
        if (failure === 'restart-cancelled')
          f.history.nativeCancelledInputs = ['input'];
        if (failure === 'lost-ack') throw new Error('Connection lost');
        return failure === 'no-active' || failure === 'restart-cancelled'
          ? undefined
          : { abortedRunId: failure === 'wrong-owner' ? 'other' : 'input' };
      },
    });
    await f.service.command({
      type: 'conversation.run.abort',
      commandId: crypto.randomUUID(),
      chatId: f.chat.id,
    });
    await f.service.reconcile();
    expect(f.store.pending(f.chat.id)).toMatchObject([
      { id: 'input', state: 'unknown', text: 'Exact accepted input' },
    ]);
    expect(f.gateway.sends).toEqual([]);
  },
);

it('persists the ACK before a failed read and settles on reconstruction without cancelling new work', async () => {
  const f = await fixture();
  const original = f.gateway.history.bind(f.gateway);
  let fail = false;
  f.gateway.history = async (...args) => {
    if (fail) throw new Error('Temporary history outage');
    return original(...args);
  };
  Object.assign(f.gateway, {
    abort: () => {
      f.history.activeRun = null;
      enqueue(f.store, {
        type: 'conversation.message.send',
        commandId: 'later',
        chatId: f.chat.id,
        text: 'Newer accepted work',
      });
      fail = true;
      return { abortedRunId: 'input' };
    },
  });
  await f.service.command({
    type: 'conversation.run.abort',
    commandId: crypto.randomUUID(),
    chatId: f.chat.id,
  });
  expect(f.store.pending(f.chat.id)).toHaveLength(2);
  f.service.close();
  await f.service.drain();
  // The service has been destroyed: only durable SQL proof may resolve this.
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id).map((item) => item.id)).toEqual(['later']);
});

it.each([
  'revision',
  'submission',
  'owner-active',
  'scope',
  'owner-remapped',
  'owner-missing',
  'owner-ambiguous',
])('does not apply confirmed proof after %s changes', async (change) => {
  const f = await fixture();
  Object.assign(f.gateway, {
    abort: () => {
      f.history.activeRun = null;
      if (change === 'revision') {
        f.input.revision += 1;
        f.store.savePending(f.input);
      }
      if (change === 'submission') {
        f.input.submissionId = 'different-submission';
        f.store.savePending(f.input);
      }
      if (change === 'owner-active')
        f.history.activeRun = { id: 'input', text: '', sequence: 2 };
      if (change === 'scope')
        f.store.saveSubmissionScope(f.input.id, 'other-session');
      if (change === 'owner-remapped')
        f.history.nativeInputOwners = [
          { inputId: 'input', runId: 'new-owner' },
        ];
      if (change === 'owner-missing') delete f.history.nativeInputOwners;
      if (change === 'owner-ambiguous')
        f.history.nativeInputOwners = [
          { inputId: 'input', runId: 'input' },
          { inputId: 'input', runId: 'other' },
        ];
      return { abortedRunId: 'input' };
    },
  });
  await f.service.command({
    type: 'conversation.run.abort',
    commandId: crypto.randomUUID(),
    chatId: f.chat.id,
  });
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
});

it('records intent before RPC and preserves a confirmed ACK through a no-active retry', async () => {
  const f = await fixture();
  let calls = 0;
  Object.assign(f.gateway, {
    abort: () => {
      const intent = f.store.db
        .prepare(
          'SELECT confirmed FROM pending_cancellations WHERE message_id=?',
        )
        .get(f.input.id);
      expect(intent).toEqual({ confirmed: calls ? 1 : 0 });
      f.history.activeRun = null;
      return calls++ ? undefined : { abortedRunId: 'input' };
    },
  });
  await abortAcceptedInputs(f.store, f.gateway, f.store.getChat(f.chat.id));
  await abortAcceptedInputs(f.store, f.gateway, f.store.getChat(f.chat.id));
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toEqual([]);
});

it('does not infer ownership from active status, input text or an abort ACK alone', async () => {
  const f = await fixture();
  delete f.history.nativeInputOwners;
  Object.assign(f.gateway, {
    abort: () => {
      f.history.activeRun = null;
      return { abortedRunId: 'input' };
    },
  });
  await f.service.command({
    type: 'conversation.run.abort',
    commandId: crypto.randomUUID(),
    chatId: f.chat.id,
  });
  expect(f.store.pending(f.chat.id)).toMatchObject([
    { id: 'input', state: 'unknown' },
  ]);
});

it('uses the same confirmed proof for explicit cancel-work settings', async () => {
  const f = await fixture();
  Object.assign(f.gateway, {
    abort: () => {
      f.history.activeRun = null;
      return { abortedRunId: 'input' };
    },
  });
  await f.service.updateSettings(
    f.chat.id,
    { ...testSettings, fastMode: true },
    'cancel-work',
    `"${f.store.getChat(f.chat.id).version}"`,
  );
  await f.service.drain();
  expect(f.store.pending(f.chat.id)).toEqual([]);
  expect(f.store.settingsOperation(f.chat.id)).toBeNull();
  expect(f.store.getChat(f.chat.id).settings.fastMode).toBe(true);
});
