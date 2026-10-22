import { expect, it, vi } from 'vitest';
import type { NativeInputCancellation } from '../src/gateway/types.js';
import { abortAcceptedInputs } from '../src/chats/cancellations.js';
import { historyWithReceipts } from '../src/chats/history.js';
import { mapping } from '../src/chats/service.js';
import type { GatewayHistory } from '../src/gateway/types.js';
import { captureAbortRequests } from '../src/chats/abort-receipts.js';
import { reconcileInputs } from '../src/chats/queue.js';
import { exactAbortFixture } from './native-exact-abort-fixture.js';

const certificate: NativeInputCancellation = {
  kind: 'pre-execution-input-cancelled',
  inputId: 'input',
  sessionId: 'native-session',
  agentId: 'agent',
  sessionKey: 'agent:agent:main',
};
function earlyFixture(outage = false) {
  const f = exactAbortFixture();
  f.history.nativeInputOwners = [];
  f.history.activeRun = { id: 'input', text: '', sequence: 1 };
  f.gateway.history = vi.fn(() =>
    outage
      ? Promise.reject(Error('History outage'))
      : Promise.resolve(structuredClone(f.history)),
  );
  const abortChat = vi.fn(() => {
    f.history.activeRun = null;
    return Promise.resolve({ runIds: ['input'], inputs: [certificate] });
  });
  const abort = vi.fn(() => Promise.resolve());
  Object.assign(f.gateway, { abortChat, abort });
  const typed = () =>
    (
      f.store.db
        .prepare('SELECT COUNT(*) count FROM pending_input_cancellations')
        .get() as { count: number }
    ).count;
  return { ...f, abortChat, abort, typed };
}

it.each([false, true])(
  'settles exact pre-execution input without a USER event after null broad ACK (history outage=%s)',
  async (outage) => {
    const f = earlyFixture(outage);
    f.abort.mockImplementation(() => {
      expect(f.typed()).toBe(1); // Durable certificate must precede the next RPC.
      return Promise.resolve();
    });
    await abortAcceptedInputs(f.store, f.gateway, f.chat);
    expect(f.abortRun).not.toHaveBeenCalled();
    expect(f.abortChat).toHaveBeenCalledOnce();
    expect(f.abort).toHaveBeenCalledOnce();
    reconcileInputs(
      f.store,
      f.chat.id,
      await historyWithReceipts(
        {
          ...f.gateway,
          history: () => Promise.resolve(structuredClone(f.history)),
        },
        mapping(f.chat),
        ['input'],
        f.store,
      ),
    );
    expect(f.store.pending(f.chat.id)).toEqual([]);
  },
);

it.each([
  'generic-only',
  'lost-ACK',
  'wrong-input',
  'wrong-scope',
  'wrong-key',
  'wrong-agent',
  'generated-owner',
  'ambiguous-owner',
  'active',
  'pending',
  'revision',
  'scope-change',
  'mapping-change',
  'same-row-replacement',
  'no-scope',
])('retains accepted input for %s', async (negative) => {
  const f = earlyFixture();
  if (negative === 'no-scope')
    f.store.db.prepare('DELETE FROM submission_scopes').run();
  f.abortChat.mockImplementation(() => {
    f.history.activeRun = null;
    if (negative === 'lost-ACK')
      return Promise.reject(Error('Connection lost'));
    const inputs = negative === 'generic-only' ? [] : [{ ...certificate }];
    if (negative === 'wrong-input') inputs[0]!.inputId = 'other';
    if (negative === 'wrong-scope') inputs[0]!.sessionId = 'other';
    if (negative === 'wrong-key') inputs[0]!.sessionKey = 'other';
    if (negative === 'wrong-agent') inputs[0]!.agentId = 'other';
    if (negative === 'revision') {
      const item = f.store.pending(f.chat.id)[0]!;
      item.revision++;
      f.store.savePending(item);
    }
    if (negative === 'scope-change')
      f.store.saveSubmissionScope('input', 'different');
    if (negative === 'mapping-change')
      f.store.saveChat({ ...f.store.getChat(f.chat.id), agentId: 'other' });
    if (negative === 'same-row-replacement') {
      f.store.removePending('input');
      f.add('input', 'input');
      captureAbortRequests(f.store, f.store.pending(f.chat.id));
      f.history.nativeInputOwners = [];
    }
    return Promise.resolve({ runIds: ['input'], inputs });
  });
  if (negative === 'lost-ACK')
    await expect(
      abortAcceptedInputs(f.store, f.gateway, f.chat),
    ).rejects.toThrow('Connection lost');
  else await abortAcceptedInputs(f.store, f.gateway, f.chat);
  if (negative === 'generated-owner')
    f.history.nativeInputOwners = [{ inputId: 'input', runId: 'generated' }];
  if (negative === 'ambiguous-owner')
    f.history.nativeInputOwners = [
      { inputId: 'input', runId: 'input' },
      { inputId: 'input', runId: 'generated' },
    ];
  if (negative === 'active')
    f.history.activeRun = { id: 'other', text: '', sequence: 1 };
  if (negative === 'pending')
    f.history.receipts = [{ runId: 'input', state: 'pending' }];
  reconcileInputs(
    f.store,
    f.chat.id,
    await historyWithReceipts(
      {
        ...f.gateway,
        history: () => Promise.resolve(structuredClone(f.history)),
      },
      mapping(f.chat),
      ['input'],
      f.store,
    ),
  );
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
  expect(f.abort).toHaveBeenCalledOnce();
});

it('retains original generated-owner contradiction even when the fresh owner disappears', async () => {
  const f = earlyFixture();
  f.history.nativeInputOwners = [{ inputId: 'input', runId: 'generated' }];
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  f.history.nativeInputOwners = [];
  reconcileInputs(
    f.store,
    f.chat.id,
    await historyWithReceipts(
      {
        ...f.gateway,
        history: () => Promise.resolve(structuredClone(f.history)),
      },
      mapping(f.chat),
      ['input'],
      f.store,
    ),
  );
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
});

it('does not give newly admitted input the original Stop certificate', async () => {
  const f = earlyFixture();
  f.abortChat.mockImplementation(() => {
    f.history.activeRun = null;
    f.add('later');
    f.history.nativeInputOwners = [];
    return Promise.resolve({
      runIds: ['input', 'later'],
      inputs: [certificate, { ...certificate, inputId: 'later' }],
    });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(
    f.store,
    f.chat.id,
    await historyWithReceipts(
      {
        ...f.gateway,
        history: () => Promise.resolve(structuredClone(f.history)),
      },
      mapping(f.chat),
      ['input'],
      f.store,
    ),
  );
  expect(f.store.pending(f.chat.id)).toMatchObject([
    { id: 'later', state: 'unknown' },
  ]);
});

it('retains monotonic positive typed receipt across a later no-active retry', async () => {
  const f = earlyFixture();
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  f.abortChat.mockResolvedValue({ runIds: [], inputs: [] });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.typed()).toBe(1);
  reconcileInputs(
    f.store,
    f.chat.id,
    await historyWithReceipts(
      {
        ...f.gateway,
        history: () => Promise.resolve(structuredClone(f.history)),
      },
      mapping(f.chat),
      ['input'],
      f.store,
    ),
  );
  expect(f.store.pending(f.chat.id)).toEqual([]);
});

it('keeps exact-owner first, typed receipt second, original session cleanup last', async () => {
  const f = earlyFixture();
  const calls: string[] = [];
  f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
  f.abortRun.mockImplementation((_mapping, owner) => {
    calls.push('exact');
    return Promise.resolve({ abortedRunId: owner });
  });
  f.abortChat.mockImplementation(() => {
    calls.push('chat');
    expect(f.proof()?.confirmed).toBe(1);
    f.history.activeRun = null;
    return Promise.resolve({ runIds: ['input'], inputs: [certificate] });
  });
  f.abort.mockImplementation(() => {
    calls.push('broad');
    expect(f.typed()).toBe(1);
    return Promise.resolve();
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(calls).toEqual(['exact', 'chat', 'broad']);
});

it('does not let an old held observation inherit a replacement row and newly certified Stop nonce', async () => {
  const f = earlyFixture();
  f.history.activeRun = null;
  captureAbortRequests(f.store, f.store.pending(f.chat.id));
  const old = structuredClone(f.history);
  let finish!: (history: GatewayHistory) => void;
  f.gateway.history = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const read = historyWithReceipts(
    f.gateway,
    mapping(f.chat),
    ['input'],
    f.store,
  );
  f.store.removePending('input');
  f.add('input', 'input');
  f.history.nativeInputOwners = [];
  f.history.activeRun = null;
  f.gateway.history = () => Promise.resolve(structuredClone(f.history));
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.typed()).toBe(1);
  finish(old);
  reconcileInputs(f.store, f.chat.id, await read);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
  const fresh = await historyWithReceipts(
    f.gateway,
    mapping(f.chat),
    ['input'],
    f.store,
  );
  reconcileInputs(f.store, f.chat.id, fresh);
  expect(f.store.pending(f.chat.id)).toEqual([]);
});

it('does not consume a typed certificate through an unsealed raw native snapshot', async () => {
  const f = earlyFixture();
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
});
