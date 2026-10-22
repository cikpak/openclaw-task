import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayCapture } from './gateway-capture.mjs';
import { readProcess, assertGatewayIdentity } from './gateway-identity.mjs';
import { crashCategory } from './gateway-diagnostic.mjs';
import { writerSnapshot, writerEvidence } from './gateway-writer-evidence.mjs';
import { waitForNativeWriters } from './gateway-writer-wait.mjs';
/** Acceptance-image only. Never a production preservation/shutdown operation. */
export async function crashGateway(effects = {}, signal) {
  let phase = 'capture';
  let target, before;
  const snapshot = effects.snapshot ?? writerSnapshot;
  const deadline = Date.now() + 30_000;
  try {
    signal?.throwIfAborted();
    assert.equal(process.env.MESSENGER_ACCEPTANCE_FIXTURE, '1');
    target = await (effects.registry ?? gatewayCapture).target();
    phase = 'dependencies';
    const read = effects.readProcess ?? readProcess;
    const members =
      effects.members ?? (await import('./processes.mjs')).members;
    const verify =
      effects.verify ?? (await import('./writers.mjs')).verifyNoWriters;
    const kill =
      effects.kill ?? ((group, signal) => process.kill(group, signal));
    before = await snapshot().catch(() => undefined);
    phase = 'identity';
    assertGatewayIdentity(target, await read(target.pid));
    signal?.throwIfAborted();
    assert.ok(Date.now() < deadline, 'Acceptance crash deadline exceeded');
    phase = 'signal';
    kill(-target.group, 'SIGKILL');
    phase = 'members';
    const groupDeadline = Math.min(Date.now() + 5000, deadline);
    while ((await members(target.group)).length) {
      assert.ok(Date.now() < groupDeadline, 'Crashed Gateway group must exit');
      await delay(25);
    }
    phase = 'writers';
    const waited = await waitForNativeWriters({
      verify,
      deadline,
      signal,
    });
    return { crashed: true, remainingWriters: 0, ...waited };
  } catch (error) {
    const rejected = new Error('Acceptance crash rejected');
    rejected.phase = phase;
    rejected.code = crashCategory(error);
    if (phase === 'writers')
      rejected.writerEvidence = writerEvidence(
        target,
        before,
        signal?.aborted || Date.now() >= deadline
          ? undefined
          : await snapshot().catch(() => undefined),
      );
    throw rejected;
  }
}
