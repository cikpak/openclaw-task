import { setTimeout as delay } from 'node:timers/promises';
import { crashCategory } from './gateway-diagnostic.mjs';
/** Let native IPC-disconnect cleanup finish; authoritative writer proof must pass. */
export async function waitForNativeWriters(effects) {
  const { verify, deadline, signal } = effects;
  const now = effects.now ?? Date.now;
  const pause = effects.delay ?? delay;
  const started = now();
  let waited = false;
  let lastError;
  for (;;) {
    signal?.throwIfAborted();
    if (now() >= deadline)
      throw lastError ?? new Error('Native writer deadline exceeded');
    try {
      await verify();
      signal?.throwIfAborted();
      if (now() >= deadline)
        throw lastError ?? new Error('Native writer deadline exceeded');
      return waited ? { writerWaitMs: now() - started } : {};
    } catch (error) {
      lastError = error;
      if (
        crashCategory(error) !== 'detached-engine-writer' ||
        now() >= deadline
      )
        throw error;
      waited = true;
      await pause(Math.min(25, deadline - now()), undefined, { signal });
    }
  }
}
