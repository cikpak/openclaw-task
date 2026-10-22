import { expect, it, vi } from 'vitest';
import { abortAcceptedInputs } from '../src/chats/cancellations.js';
import { captureAbortRequests } from '../src/chats/abort-receipts.js';
import { reconcileInputs } from '../src/chats/queue.js';
import {
  exactAbortFixture,
  exactCallerFixture,
} from './native-exact-abort-fixture.js';
import { testSettings } from './fake-gateway.js';

it.each([
  'revision',
  'submission',
  'scope',
  'reset',
  'missing-owner',
  'ambiguous-owner',
  'generated-owner',
  'active-owner',
  'replaced-row',
])(
  'retains original cancellation fences after owner visibility recovers: %s',
  async (change) => {
    const f = exactAbortFixture();
    f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
    const preflight = structuredClone(f.history);
    delete preflight.nativeInputOwners;
    f.gateway.history = () => Promise.resolve(preflight);
    f.abort.mockImplementation(() => {
      f.history.activeRun =
        change === 'active-owner'
          ? { id: 'input', text: '', sequence: 2 }
          : null;
      const item = f.store.pending(f.chat.id)[0]!;
      if (change === 'revision') {
        item.revision++;
        f.store.savePending(item);
      }
      if (change === 'submission') {
        item.submissionId = 'new';
        f.store.savePending(item);
      }
      if (change === 'scope')
        f.store.saveSubmissionScope(item.id, 'new-session');
      if (change === 'reset') f.history.sessionId = 'new-session';
      if (change === 'missing-owner') f.history.nativeInputOwners = [];
      if (change === 'ambiguous-owner')
        f.history.nativeInputOwners!.push({ inputId: 'input', runId: 'other' });
      if (change === 'generated-owner')
        f.history.nativeInputOwners = [
          { inputId: 'input', runId: 'generated' },
        ];
      if (change === 'replaced-row') {
        f.store.removePending(item.id);
        f.add('replacement', 'input');
      }
      return Promise.resolve({ abortedRunId: 'input' });
    });
    await abortAcceptedInputs(f.store, f.gateway, f.chat);
    reconcileInputs(f.store, f.chat.id, f.history);
    expect(f.store.pending(f.chat.id)).toHaveLength(1);
  },
);

it('keeps exact ACK through history outage/retry and allows only the originally captured row', async () => {
  const f = exactAbortFixture();
  f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
  f.gateway.history = () => Promise.reject(Error('History unavailable'));
  f.abort.mockImplementationOnce(() => {
    f.history.activeRun = null;
    f.add('later', 'input');
    return Promise.resolve({ abortedRunId: 'input' });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  f.gateway.abort = () => Promise.resolve(undefined);
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(f.store, f.chat.id, structuredClone(f.history));
  expect(f.store.pending(f.chat.id)).toMatchObject([
    { id: 'later', state: 'unknown' },
  ]);
});

it('does not record a cancellation receipt for lost or absent native ACK', async () => {
  const f = exactAbortFixture();
  f.gateway.history = () => Promise.reject(Error('History unavailable'));
  f.gateway.abort = vi
    .fn()
    .mockRejectedValueOnce(Error('Lost ACK'))
    .mockResolvedValue(undefined);
  await expect(abortAcceptedInputs(f.store, f.gateway, f.chat)).rejects.toThrow(
    'Lost ACK',
  );
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  f.history.activeRun = null;
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
});

it.each(['Stop', 'cancel-work'])(
  'resolves delayed canonical ownership through the actual %s caller',
  async (action) => {
    const f = await exactCallerFixture();
    const original = f.gateway.history.bind(f.gateway);
    let first = true;
    f.gateway.history = async (...args) => {
      const history = structuredClone(await original(...args));
      if (first) {
        first = false;
        delete history.nativeInputOwners;
      }
      return history;
    };
    const native = f.gateway.histories.get(f.chat.sessionKey!)!;
    native.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
    native.activeRun = { id: 'input', text: '', sequence: 1 };
    f.abort.mockImplementation(() => {
      native.activeRun = null;
      return Promise.resolve({ abortedRunId: 'input' });
    });
    if (action === 'Stop') {
      expect(
        await f.service.command({
          type: 'conversation.run.abort',
          commandId: crypto.randomUUID(),
          chatId: f.chat.id,
        }),
      ).toMatchObject({ ok: true });
    } else {
      await f.service.updateSettings(
        f.chat.id,
        { ...testSettings, fastMode: true },
        'cancel-work',
        `"${f.chat.version}"`,
      );
      await f.service.drain();
      expect(f.store.settingsOperation(f.chat.id)).toBeNull();
    }
    expect(f.abortRun).not.toHaveBeenCalled();
    expect(f.store.pending(f.chat.id)).toEqual([]);
  },
);

it('cannot substitute a remapped owner even when it equals a retained broad ACK', async () => {
  const f = exactAbortFixture();
  f.gateway.abortRun = () => Promise.resolve(undefined);
  f.abort.mockImplementation(() => {
    f.history.activeRun = null;
    f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
    return Promise.resolve({ abortedRunId: 'input' });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toMatchObject([
    { id: 'input', state: 'unknown' },
  ]);
});

it('rejects a replaced request nonce even when message ID and tuple are reused', async () => {
  const f = exactAbortFixture();
  const preflight = structuredClone(f.history);
  delete preflight.nativeInputOwners;
  f.gateway.history = () => Promise.resolve(preflight);
  f.abort.mockImplementation(() => {
    f.store.removePending('input');
    f.add('input', 'input');
    f.history.activeRun = null;
    return Promise.resolve({ abortedRunId: 'input' });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
  expect(
    f.store.db
      .prepare('SELECT COUNT(*) count FROM pending_abort_receipts')
      .get(),
  ).toEqual({ count: 0 });
});

it('retains all positive ACK identities while later no-active retries cannot erase them', async () => {
  const f = exactAbortFixture();
  f.gateway.history = () => Promise.reject(Error('History outage'));
  f.gateway.abort = vi
    .fn()
    .mockResolvedValueOnce({ abortedRunId: 'unrelated' })
    .mockResolvedValueOnce({ abortedRunId: 'input' })
    .mockResolvedValue(undefined);
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
  f.history.activeRun = null;
  expect(
    f.store.db
      .prepare('SELECT COUNT(*) count FROM pending_abort_receipts')
      .get(),
  ).toEqual({ count: 2 });
  reconcileInputs(f.store, f.chat.id, structuredClone(f.history));
  expect(f.store.pending(f.chat.id)).toEqual([]);
  expect(
    f.store.db
      .prepare('SELECT COUNT(*) count FROM pending_abort_receipts')
      .get(),
  ).toEqual({ count: 0 });
});

it('does not adopt a new native scope returned during the preflight await', async () => {
  const f = exactAbortFixture();
  f.gateway.history = () => {
    f.store.saveSubmissionScope('input', 'replacement-scope');
    f.history.sessionId = 'replacement-scope';
    return Promise.resolve(structuredClone(f.history));
  };
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.abortRun).not.toHaveBeenCalled();
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
});

it.each(['preflight', 'RPC'])(
  'rejects same-ID exact-tuple replacement with a new request nonce during %s',
  async (phase) => {
    const f = exactAbortFixture();
    f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
    const replace = () => {
      f.store.removePending('input');
      f.history.nativeInputOwners = [];
      f.add('input', 'input');
      captureAbortRequests(f.store, f.store.pending(f.chat.id));
    };
    f.gateway.history = () => {
      if (phase === 'preflight') replace();
      return Promise.resolve(structuredClone(f.history));
    };
    f.gateway.abortRun = () => {
      if (phase === 'RPC') replace();
      return Promise.resolve({ abortedRunId: 'input' });
    };
    await abortAcceptedInputs(f.store, f.gateway, f.chat);
    reconcileInputs(f.store, f.chat.id, f.history);
    expect(f.store.pending(f.chat.id)).toHaveLength(1);
    expect(
      f.store.db
        .prepare('SELECT COUNT(*) count FROM pending_abort_receipts')
        .get(),
    ).toEqual({ count: 0 });
  },
);

it('seals authorization before history yields and stores the ACK before any later observation', async () => {
  const f = exactAbortFixture();
  const preflight = structuredClone(f.history);
  delete preflight.nativeInputOwners;
  let token: unknown;
  f.gateway.history = () => {
    const row = f.store.db
      .prepare(
        'SELECT request_id FROM pending_abort_requests WHERE message_id=?',
      )
      .get('input') as { request_id: string };
    expect(row.request_id).toEqual(expect.any(String));
    token = row.request_id;
    expect(
      f.store.db
        .prepare('SELECT COUNT(*) count FROM pending_abort_receipts')
        .get(),
    ).toEqual({ count: 0 });
    return Promise.resolve(preflight);
  };
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(
    f.store.db.prepare('SELECT request_id FROM pending_abort_receipts').get(),
  ).toEqual({ request_id: token });
});
