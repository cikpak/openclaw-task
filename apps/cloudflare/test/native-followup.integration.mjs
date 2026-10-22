import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fixture, until } from './native-followup-fixture.mjs';
import { provider } from './native-followup-provider.mjs';
import { canonical } from './native-followup-transcript.mjs';
import { physical } from './native-followup-physical.mjs';
import { pendingProof } from './native-followup-reconcile.mjs';
import { resetProof } from './native-followup-reset.mjs';
import { stopGenerated } from './native-followup-stop.mjs';
import { recoveryStore } from './native-followup-r2.mjs';

const started = Date.now();
const model = await provider();
let recovery;
let f;
const evidence = {};
const mapping = { agentId: 'main', sessionKey: 'agent:main:main' };
const parent = randomUUID(),
  input = randomUUID();
let owner, scope, beforeProvider;
const nativeFailure = () => {
  const failed = model.calls.find((call) => call.failed);
  if (failed)
    throw new Error(`Provider boundary assertion failed: ${failed.failed}`);
};
try {
  recovery = await recoveryStore();
  f = await fixture(model.url, recovery);
  model.verify(async (_call, index) => {
    if (index !== 2) return;
    const stored = await canonical(f, mapping);
    const row = stored.rows.find(
      (entry) =>
        entry.role === 'user' &&
        entry.meta?.messengerProcessing?.keys?.includes(`${input}:user`),
    );
    assert.ok(
      row,
      'Actual canonical USER must carry exact source→execution proof before followup provider request',
    );
    assert.equal(row.key, `${input}:user`);
    assert.deepEqual(row.meta.messengerProcessing.keys, [`${input}:user`]);
    owner = row.meta.messengerProcessing.runId;
    assert.notEqual(owner, parent);
    assert.notEqual(owner, input);
    assert.ok(row.id && !row.id.startsWith('pending:'));
    scope = stored.scope;
    beforeProvider = await f.gateway.history(mapping, { inputRunIds: [input] });
    assert.equal(
      beforeProvider.completedInputs?.includes(input) ?? false,
      false,
      'Owner association alone is not completion',
    );
    assert.equal(
      JSON.stringify(beforeProvider.messages).includes('messengerProcessing'),
      false,
    );
    evidence.preProvider = {
      ownerDistinctFromParent: owner !== parent,
      ownerDistinctFromInput: owner !== input,
      exactProtectedSourceKey: true,
      physicallyCanonical: true,
      nativeUid: stored.uid,
      ownerAloneNotComplete: true,
    };
  });
  await f.start();
  console.info('FOLLOWUP_IMAGE_SDK_READY');
  const manifest = await f.node(
    "import {readFile} from 'node:fs/promises';emit(JSON.parse(await readFile('/app/dist/messenger-compatibility.json','utf8')));",
  );
  assert.equal(manifest.version, '2026.10.1');
  assert.ok(manifest.modules.every((entry) => entry.before !== entry.after));
  await f.gateway.request('sessions.create', {
    agentId: 'main',
    key: mapping.sessionKey,
    idempotencyKey: randomUUID(),
    permissionMode: 'workspace',
  });
  await f.gateway.send(
    mapping,
    parent,
    'Parent held for exact followup image proof',
    'queue',
  );
  await until(() => model.calls.length === 1, 'parent provider active');
  const ack = await f.gateway.send(
    mapping,
    input,
    'Official queued followup image proof',
    'queue',
  );
  assert.equal(ack.runId, input);
  assert.equal(
    model.calls.length,
    1,
    'Followup must remain queued while its parent provider is active',
  );
  model.release();
  await until(() => {
    nativeFailure();
    return model.calls[1]?.finished;
  }, 'actual generated-owner followup provider completion');
  const completed = await until(async () => {
    nativeFailure();
    const result = await f.gateway.history(mapping, { inputRunIds: [input] });
    return result.completedInputs?.includes(input) ? result : false;
  }, 'exact same-owner causal successful native completion');
  assert.equal(completed.sessionId, scope);
  assert.equal(
    completed.nativeInputOwners.find((entry) => entry.inputId === input)?.runId,
    owner,
  );
  const after = await canonical(f, mapping);
  console.info('FOLLOWUP_IMAGE_NATIVE_CAUSAL_COMPLETION');
  const user = after.page.messages.find(
    (entry) => entry.__openclaw?.messengerProcessing?.runId === owner,
  );
  const final = after.page.messages.find(
    (entry) =>
      entry.role === 'assistant' &&
      entry.__openclaw?.runId === owner &&
      entry.stopReason === 'stop',
  );
  assert.ok(user && final);
  assert.ok(final.__openclaw.seq > user.__openclaw.seq);
  assert.equal(final.channel === undefined || final.channel === 'final', true);
  Object.assign(evidence, await pendingProof(completed, input, scope));
  assert.equal(
    model.calls.length,
    2,
    'One parent and one actual followup provider execution',
  );
  const preserved = after.rows.find(
    (entry) =>
      entry.role === 'user' && entry.meta?.messengerProcessing?.runId === owner,
  );
  await f.gateway.stop();
  await f.job('stop');
  await f.start();
  const restarted = await f.gateway.history(mapping, { inputRunIds: [input] });
  assert.equal(restarted.sessionId, scope);
  assert.ok(restarted.completedInputs.includes(input));
  assert.deepEqual(
    (await canonical(f, mapping)).rows.find(
      (entry) => entry.id === preserved.id,
    ),
    preserved,
  );
  evidence.gatewayProcessRestartRetainsExactProof = true;
  console.info('FOLLOWUP_IMAGE_PROCESS_RESTART_PRESERVED');
  const descriptor = await f.restore();
  const restored = await f.gateway.history(mapping, { inputRunIds: [input] });
  assert.equal(restored.sessionId, scope);
  assert.ok(restored.completedInputs.includes(input));
  assert.deepEqual(
    (await canonical(f, mapping)).rows.find(
      (entry) => entry.id === preserved.id,
    ),
    preserved,
  );
  evidence.freshArchiveRestoreRetainsExactProof = true;
  evidence.inventoryDigest = descriptor.inventoryDigest;
  console.info('FOLLOWUP_IMAGE_FRESH_HELPER_RESTORE_PRESERVED');
  const physicalMapping = {
    agentId: 'main',
    sessionKey: 'agent:main:physical-owner-proof',
  };
  await f.gateway.request('sessions.create', {
    agentId: 'main',
    key: physicalMapping.sessionKey,
    idempotencyKey: randomUUID(),
    permissionMode: 'workspace',
  });
  evidence.physical = await physical(f, physicalMapping);
  console.info('FOLLOWUP_IMAGE_PHYSICAL_STAGED_GROUP_PROOF');
  evidence.reset = await resetProof(f, physicalMapping);
  evidence.stop = await stopGenerated(f, model, mapping);
  assert.equal(
    evidence.stop.cancellationOutcome,
    'confirmed-exact-owner',
    'A controlled-unknown Stop remains an open behavior gate',
  );
  Object.assign(evidence, {
    passed: true,
    image: f.image,
    bakedCompatibilityManifest: manifest,
    officialNativeFollowupProcessor: true,
    uiLateSteerTiming: 'separate acceptance gate',
    noSourceMounts: true,
    providerCalls: model.calls.length,
    elapsedMs: Date.now() - started,
  });
  console.info(JSON.stringify(evidence));
} finally {
  const evidencePath = resolve(
    process.env.OPENCLAW_FOLLOWUP_EVIDENCE ??
      '.context/native-followup-image-evidence.json',
  );
  console.info(JSON.stringify({ nativeFollowupEvidence: evidence }));
  const results = await Promise.allSettled([
    (async () => {
      await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2), {
        mode: 0o600,
      });
    })(),
    model.close(),
    f?.close(),
    recovery?.close(),
  ]);
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length) {
    console.error('Native probe cleanup encountered an additional failure');
    process.exitCode = 1;
  }
}
