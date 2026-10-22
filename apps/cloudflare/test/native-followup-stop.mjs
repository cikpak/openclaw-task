import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { until } from './native-followup-fixture.mjs';
import { canonical } from './native-followup-transcript.mjs';
import { domain, outcomeStore } from './native-followup-reconcile.mjs';
import { observeAborts } from './native-followup-abort-observer.mjs';
/** Active generated owners must use the real app cancellation boundary, never a guessed ACK mapping. */
export async function stopGenerated(f, model, mapping) {
  const parent = randomUUID(),
    input = randomUUID();
  const parentIndex = model.calls.length + 1,
    followupIndex = parentIndex + 1;
  model.hold(parentIndex);
  model.hold(followupIndex);
  let owner, scope;
  model.verify(async (_call, index) => {
    if (index !== followupIndex) return;
    const value = await canonical(f, mapping);
    const row = value.rows.find((entry) =>
      entry.meta?.messengerProcessing?.keys.includes(`${input}:user`),
    );
    assert.ok(row);
    owner = row.meta.messengerProcessing.runId;
    scope = value.scope;
    assert.notEqual(owner, parent);
    assert.notEqual(owner, input);
  });
  await f.gateway.send(
    mapping,
    parent,
    'Active generated followup Stop parent',
    'queue',
  );
  await until(() => model.calls.length === parentIndex, 'Stop parent active');
  await f.gateway.send(
    mapping,
    input,
    'Active generated followup Stop input',
    'queue',
  );
  model.release(parentIndex);
  await until(() => {
    const failed = model.calls.find((call) => call.failed);
    if (failed) throw new Error(String(failed.failed));
    return Boolean(owner);
  }, 'generated followup proof before Stop');
  const before = await f.gateway.history(mapping, { inputRunIds: [input] });
  assert.equal(before.activeRun?.id, owner);
  assert.equal(
    before.nativeInputOwners.find((entry) => entry.inputId === input)?.runId,
    owner,
  );
  const { Store, reconcileInputs, abortAcceptedInputs } = await domain();
  const store = outcomeStore(Store, before, input, scope);
  let durableExactAckBeforeBroadCleanup = false;
  const observation = observeAborts(f.gateway, { owner, input, parent }, () => {
    const proof = store.db
      .prepare('SELECT confirmed FROM pending_cancellations WHERE message_id=?')
      .get(input);
    durableExactAckBeforeBroadCleanup = proof?.confirmed === 1;
  });
  try {
    await abortAcceptedInputs(
      store,
      observation.gateway,
      store.getChat('probe'),
    );
    const rpc = observation.evidence();
    assert.deepEqual(
      rpc.raw.map((call) => call.kind),
      ['exact', 'broad'],
    );
    assert.equal(rpc.raw[0].requestedExactOwner, true);
    assert.equal(rpc.raw[0].clearQueued, false);
    assert.equal(rpc.raw[1].clearQueued, true);
    const proof = store.db
      .prepare('SELECT * FROM pending_cancellations WHERE message_id=?')
      .get(input);
    assert.equal(proof.owner_run_id, owner);
    const after = await until(async () => {
      const history = await f.gateway.history(mapping, {
        inputRunIds: [input],
      });
      return history.activeRun?.id !== owner ? history : false;
    }, 'native generated owner stopped');
    reconcileInputs(store, 'probe', after);
    if (proof.confirmed) {
      assert.equal(store.pending('probe').length, 0);
      assert.equal(durableExactAckBeforeBroadCleanup, true);
    } else {
      assert.equal(store.pending('probe').length, 1);
      assert.equal(store.pending('probe')[0].state, 'unknown');
    }
    return {
      activeGeneratedOwner: true,
      exactPrivateOwnerCaptured: true,
      nativeStopped: true,
      cancellationOutcome: proof.confirmed
        ? 'confirmed-exact-owner'
        : 'controlled-unknown',
      speculativeOwnerMapping: false,
      durableExactAckBeforeBroadCleanup,
      rpc,
    };
  } finally {
    observation.close();
    store.close();
    model.release(followupIndex);
  }
}
