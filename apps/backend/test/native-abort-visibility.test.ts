import { expect, it, vi } from 'vitest';
import { abortAcceptedInputs } from '../src/chats/cancellations.js';
import { reconcileInputs } from '../src/chats/queue.js';
import { exactAbortFixture } from './native-exact-abort-fixture.js';

it.each(['canonical-not-visible', 'history-unavailable'])(
  'settles an exact native direct Stop ACK after %s preflight recovers',
  async (gap) => {
    const f = exactAbortFixture();
    f.history.activeRun = { id: 'input', text: '', sequence: 1 };
    f.history.nativeInputOwners = [{ inputId: 'input', runId: 'input' }];
    const preflight = structuredClone(f.history);
    delete preflight.nativeInputOwners;
    f.gateway.history = vi.fn(() =>
      gap === 'history-unavailable'
        ? Promise.reject(Error('Transient native history outage'))
        : Promise.resolve(preflight),
    );
    await abortAcceptedInputs(f.store, f.gateway, f.chat);
    expect(f.abortRun).not.toHaveBeenCalled();
    expect(f.abort).toHaveBeenCalledOnce();
    reconcileInputs(f.store, f.chat.id, f.history);
    // The original exact native scope, canonical owner and successful abort ACK
    // agree after the visibility gap; no input-to-generated-owner mapping occurs.
    expect(f.store.pending(f.chat.id)).toEqual([]);
  },
);

it('retains generated input uncertainty when the broad logical ACK differs from its later canonical owner', async () => {
  const f = exactAbortFixture();
  const preflight = structuredClone(f.history);
  delete preflight.nativeInputOwners;
  f.gateway.history = () => Promise.resolve(preflight);
  await abortAcceptedInputs(f.store, f.gateway, f.chat);
  expect(f.abortRun).not.toHaveBeenCalled();
  reconcileInputs(f.store, f.chat.id, f.history);
  expect(f.store.pending(f.chat.id)).toMatchObject([
    { id: 'input', state: 'unknown' },
  ]);
});
