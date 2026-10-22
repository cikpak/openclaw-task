import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/database.js';
import { enqueue, reconcileInputs } from '../src/chats/queue.js';
import { normalizedTestSettings } from './fake-gateway.js';
import type { GatewayHistory } from '../src/gateway/types.js';
import { historyWithReceipts } from '../src/chats/history.js';
import type { Gateway } from '../src/gateway/types.js';
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture(scope: string | null = 'native-session') {
  const store = new Store(':memory:');
  stores.push(store);
  store.reserveChat({
    id: 'chat',
    creationId: 'create',
    name: 'Chat',
    status: 'recovery',
    agentId: 'agent-a',
    sessionKey: 'agent:agent-a:main',
    version: 1,
    unread: false,
    createdAt: 1,
    updatedAt: 1,
    settings: normalizedTestSettings,
  });
  const input = enqueue(store, {
    type: 'conversation.message.send',
    commandId: 'input',
    chatId: 'chat',
    text: 'Same text',
  });
  input.state = 'unknown';
  store.savePending(input);
  if (scope) store.saveSubmissionScope(input.id, scope);
  const history: GatewayHistory = {
    sessionId: 'native-session',
    messages: [],
    activeRun: null,
    receipts: [],
    completedInputs: ['input'],
    settings: normalizedTestSettings,
    historyCursor: null,
    hasOlderHistory: false,
  };
  return { store, input, history };
}
it('settles exact native processing completion after reconstruction without replay or terminal memory', () => {
  const f = fixture();
  reconcileInputs(f.store, 'chat', f.history);
  expect(f.store.pending('chat')).toEqual([]);
});

it.each([false, true])(
  'requires explicit app cancellation intent plus original native session (intent: %s)',
  (intent) => {
    const f = fixture();
    f.history.completedInputs = [];
    f.history.nativeCancelledInputs = ['input'];
    reconcileInputs(f.store, 'chat', f.history, undefined, intent);
    expect(f.store.pending('chat')).toHaveLength(intent ? 0 : 1);
    const reset = fixture('old-session');
    reset.history.completedInputs = [];
    reset.history.nativeCancelledInputs = ['input'];
    reconcileInputs(reset.store, 'chat', reset.history, undefined, true);
    expect(reset.store.pending('chat')).toHaveLength(1);
  },
);
it.each(['reset-session', null])(
  'retains unresolved input if durable session scope differs or is absent: %s',
  (scope) => {
    const f = fixture(scope);
    reconcileInputs(f.store, 'chat', f.history);
    expect(f.store.pending('chat')[0]?.state).toBe('unknown');
  },
);
it('keeps the exact active input submitted and never releases it from journal admission alone', () => {
  const f = fixture();
  f.history.activeRun = { id: 'input', text: '', sequence: 1 };
  reconcileInputs(f.store, 'chat', f.history);
  expect(f.store.pending('chat')[0]?.state).toBe('submitted');
});
it('honors explicit pending/cancelled proof before canonical fallback', () => {
  const f = fixture();
  f.history.receipts = [{ runId: 'input', state: 'pending' }];
  reconcileInputs(f.store, 'chat', f.history);
  expect(f.store.pending('chat')[0]?.state).toBe('submitted');
  f.history.receipts[0]!.cancelled = true;
  reconcileInputs(f.store, 'chat', f.history);
  expect(f.store.pending('chat')).toEqual([]);
});

it('retains private proofs across receipt batches beyond fifty IDs and rejects reset sessions', async () => {
  const f = fixture();
  const ids = Array.from({ length: 60 }, (_, index) => `input-${index}`);
  const history = vi.fn(
    (_target, options: { inputRunIds: string[] }): Promise<GatewayHistory> =>
      Promise.resolve({
        ...f.history,
        completedInputs: options.inputRunIds,
        nativeInputOwners: options.inputRunIds.map((inputId) => ({
          inputId,
          runId: inputId,
        })),
      }),
  );
  const gateway = { history } as unknown as Gateway;
  const result = await historyWithReceipts(
    gateway,
    { agentId: 'agent-a', sessionKey: 'agent:agent-a:main' },
    ids,
  );
  expect(result.completedInputs).toEqual(ids);
  expect(result.nativeInputOwners?.map((owner) => owner.inputId)).toEqual(ids);
  expect(history).toHaveBeenCalledTimes(2);
  history
    .mockResolvedValueOnce(f.history)
    .mockResolvedValueOnce({ ...f.history, sessionId: 'reset' });
  await expect(
    historyWithReceipts(
      gateway,
      { agentId: 'agent-a', sessionKey: 'agent:agent-a:main' },
      ids,
    ),
  ).rejects.toThrow();
});
