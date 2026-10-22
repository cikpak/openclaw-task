import { expect, it, vi } from 'vitest';
import {
  abortAcceptedInputs,
  confirmedCancellation,
} from '../src/chats/cancellations.js';
import { reconcileInputs } from '../src/chats/queue.js';
import { testSettings } from './fake-gateway.js';
import {
  exactCallerFixture,
  exactAbortFixture,
} from './native-exact-abort-fixture.js';

it('persists generated-owner ACK before broad cleanup yields and deduplicates grouped inputs', async () => {
  const f = exactAbortFixture();
  f.add('grouped');
  f.abort.mockImplementation(() => {
    expect(f.proof()?.confirmed).toBe(1);
    expect(f.proof('grouped')?.confirmed).toBe(1);
    f.history.activeRun = null;
    return Promise.resolve({ abortedRunId: 'input' });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.abortRun).toHaveBeenCalledExactlyOnceWith(
    { agentId: 'agent', sessionKey: 'agent:agent:main' },
    'generated',
  );
  expect(f.abort).toHaveBeenCalledOnce();
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toEqual([]);
});

it.each(['lost', 'mismatch', 'no-active'])(
  'retains Unknown for targeted %s despite logical broad ACK',
  async (kind) => {
    const f = exactAbortFixture();
    f.gateway.abortRun = vi.fn(() => {
      if (kind === 'lost') return Promise.reject(Error('lost exact ACK'));
      return Promise.resolve(
        kind === 'no-active' ? undefined : { abortedRunId: 'input' },
      );
    });
    const outcome = abortAcceptedInputs(f.store, f.gateway, f.chat);
    if (kind === 'lost')
      await expect(outcome).rejects.toThrow('lost exact ACK');
    else await outcome;
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.proof()?.confirmed).toBe(0);
    reconcileInputs(f.store, f.chat.id, f.history);
    expect(f.store.pending(f.chat.id)).toMatchObject([
      { id: 'input', state: 'unknown', text: 'Exact accepted input' },
    ]);
  },
);

it('preserves proof across broad failure, owner retry and reconstruction without cancelling new work', async () => {
  const f = exactAbortFixture();
  f.abort.mockImplementationOnce(() => {
    expect(f.proof()?.confirmed).toBe(1);
    f.add('later');
    return Promise.reject(Error('broad connection lost'));
  });
  await expect(abortAcceptedInputs(f.store, f.gateway, f.chat)).rejects.toThrow(
    'broad connection lost',
  );
  expect(f.proof()?.confirmed).toBe(1);
  f.gateway.abortRun = () => Promise.resolve(undefined);
  f.history.activeRun = null;
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.proof()?.confirmed).toBe(1);
  // Reconciliation uses only durable proof and a fresh independent native view.
  const recovered = structuredClone(f.history);
  expect(confirmedCancellation(f.store, f.input, recovered)).toBe(true);
  reconcileInputs(f.store, f.chat.id, recovered);
  expect(f.store.pending(f.chat.id)).toMatchObject([
    { id: 'later', state: 'unknown' },
  ]);
});

it.each([
  'scope',
  'revision',
  'submission',
  'remapped-owner',
  'missing-owner',
  'active-owner',
])('does not bypass %s fences after an exact ACK', async (kind) => {
  const f = exactAbortFixture();
  f.abort.mockImplementation(() => {
    f.history.activeRun =
      kind === 'active-owner'
        ? { id: 'generated', text: '', sequence: 2 }
        : null;
    if (kind === 'scope') f.history.sessionId = 'new-session';
    if (kind === 'remapped-owner')
      f.history.nativeInputOwners = [{ inputId: 'input', runId: 'other' }];
    if (kind === 'missing-owner') f.history.nativeInputOwners = [];
    if (kind === 'revision' || kind === 'submission') {
      const item = f.store.pending(f.chat.id)[0]!;
      if (kind === 'revision') item.revision++;
      else item.submissionId = 'new-submission';
      f.store.savePending(item);
    }
    return Promise.resolve({ abortedRunId: 'input' });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toHaveLength(1);
});

it('still confirms a valid exact direct owner from the broad RPC after targeted no-active', async () => {
  const f = exactAbortFixture();
  f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
  f.history.activeRun = { id: 'input', text: '', sequence: 1 };
  f.gateway.abortRun = () => Promise.resolve(undefined);
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toEqual([]);
});

it('always attempts every grouped owner and broad cleanup while preserving errors', async () => {
  const f = exactAbortFixture();
  f.add('second', 'another');
  const target = vi.fn().mockRejectedValue(Error('target failed'));
  const broad = vi.fn().mockRejectedValue(Error('broad failed'));
  f.gateway.abortRun = target;
  f.gateway.abort = broad;
  await expect(abortAcceptedInputs(f.store, f.gateway, f.chat)).rejects.toThrow(
    AggregateError,
  );
  expect(target).toHaveBeenCalledTimes(2);
  expect(broad).toHaveBeenCalledOnce();
  expect(f.proof()?.confirmed).toBe(0);
});

it('commits each exact owner ACK before the next owner request', async () => {
  const f = exactAbortFixture();
  f.add('second', 'another');
  f.gateway.abortRun = vi.fn((_mapping: unknown, owner: string) => {
    if (owner === 'another') expect(f.proof()?.confirmed).toBe(1);
    return Promise.resolve({ abortedRunId: owner });
  });
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.proof()?.confirmed).toBe(1);
  expect(f.proof('second')?.confirmed).toBe(1);
});
it.each(['Stop', 'cancel-work'])(
  'uses exact generated cancellation through real %s caller',
  async (action) => {
    const f = await exactCallerFixture();
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
      expect(f.store.getChat(f.chat.id).settings.fastMode).toBe(true);
    }
    expect(f.abortRun).toHaveBeenCalledExactlyOnceWith(
      { agentId: f.chat.agentId, sessionKey: f.chat.sessionKey },
      'generated',
    );
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.store.pending(f.chat.id)).toEqual([]);
    expect(f.gateway.sends).toEqual([]);
  },
);

it.each(['revision', 'submission', 'scope', 'replaced-row'])(
  'does not confirm a changed %s while the targeted ACK is pending',
  async (kind) => {
    const f = exactAbortFixture();
    f.gateway.abortRun = () => {
      const item = f.store.pending(f.chat.id)[0]!;
      if (kind === 'scope') f.store.saveSubmissionScope(item.id, 'reset');
      else if (kind === 'replaced-row') {
        f.store.removePending(item.id);
        f.add('replacement');
      } else {
        if (kind === 'revision') item.revision++;
        else item.submissionId = 'new-submission';
        f.store.savePending(item);
      }
      return Promise.resolve({ abortedRunId: 'generated' });
    };
    await abortAcceptedInputs(f.store, f.gateway, f.chat);
    expect(f.proof()?.confirmed ?? 0).toBe(0);
    expect(f.proof('replacement')).toBeUndefined();
    reconcileInputs(f.store, f.chat.id, f.history);
    expect(f.store.pending(f.chat.id)).toHaveLength(1);
  },
);
