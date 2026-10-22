import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fixture, until } from './native-followup-fixture.mjs';
import { recoveryStore } from './native-followup-r2.mjs';
import { assertPreserved } from './native-tool-policy-oracle.mjs';

const started = Date.now();
const evidence = { passed: false };
let f, recovery, failure;
let cleanupErrors = [];
const app = resolve(import.meta.dirname, '..');
const output = resolve(app, 'node_modules/.cache/tool-policy/proof.mjs');
const applied = (value) =>
  value.valid === true &&
  typeof value.configRevisionHash === 'string' &&
  value.configRevisionHash === value.appliedConfigHash;
try {
  await mkdir(dirname(output), { recursive: true });
  await build({
    entryPoints: [resolve(app, 'src/engine/gateway/tool-policy.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const { ensureDirectToolLoading } = await import(pathToFileURL(output).href);
  recovery = await recoveryStore();
  // No provider process or provider invocation is needed for native config mutation.
  f = await fixture('http://127.0.0.1:18889/v1', recovery);
  await f.start();
  evidence.bootstrapReadiness = f.bootstrapStatus();
  f.gateway.dispatch(false);
  const before = await until(async () => {
    const value = await f.gateway.request('config.get', {});
    return applied(value) ? value : false;
  }, 'initial native applied configuration');
  assert.notEqual(
    before.config.plugins?.entries?.codex?.config?.codexDynamicToolsLoading,
    'direct',
  );
  const calls = [];
  let patchAcknowledged = false;
  const request = async (method, params) => {
    calls.push(method);
    const value = await f.gateway.request(method, params);
    if (method === 'config.patch') {
      patchAcknowledged = value.ok === true && typeof value.hash === 'string';
      assert.equal(params.baseHash, before.hash);
    }
    return value;
  };
  assert.equal(await ensureDirectToolLoading(request), true);
  assert.equal(patchAcknowledged, true);
  assert.deepEqual(calls, ['config.get', 'config.patch', 'config.get']);
  assert.equal(
    f.gateway.ready,
    false,
    'Policy must not unblock dispatch itself',
  );
  const after = await f.gateway.request('config.get', {});
  assert.equal(applied(after), true);
  assert.equal(
    after.config.plugins.entries.codex.config.codexDynamicToolsLoading,
    'direct',
  );
  evidence.initialMigration = {
    officialSdkPatchAcknowledged: true,
    freshBaseHash: true,
    appliedRevisionVerified: true,
    foreignConfigurationPreserved: false,
    dispatchStayedBlocked: true,
  };
  assertPreserved(before.config, after.config);
  evidence.initialMigration.foreignConfigurationPreserved = true;
  console.info('TOOL_POLICY_NATIVE_CAS_MIGRATION_PASS');
  calls.length = 0;
  assert.equal(await ensureDirectToolLoading(request), true);
  assert.deepEqual(calls, ['config.get']);
  evidence.alreadyDirectNoop = true;
  evidence.beforeRestore = {
    pairing: f.pairingStatus(),
    jobs: await f.jobStatus(),
  };
  try {
    await f.restore();
  } catch (error) {
    evidence.restoreFailure = {
      helperStatus: error.helperStatus,
      helperCategory: error.helperCategory,
      pairing: f.pairingStatus(),
      jobs: await f.jobStatus().catch(() => [{ action: 'unavailable' }]),
    };
    throw error;
  }
  f.gateway.dispatch(false);
  calls.length = 0;
  assert.equal(await ensureDirectToolLoading(request), true);
  assert.deepEqual(calls, ['config.get']);
  const restored = await f.gateway.request('config.get', {});
  assert.equal(applied(restored), true);
  assertPreserved(before.config, restored.config);
  evidence.realFreshRestoreDirectNoop = true;
  evidence.image = f.image;
  evidence.noProviderCalls = true;
  evidence.passed = true;
  console.info('TOOL_POLICY_FRESH_NATIVE_RESTORE_NOOP_PASS');
} catch (error) {
  failure = error;
} finally {
  evidence.elapsedMs = Date.now() - started;
  const destination = resolve(
    process.env.OPENCLAW_TOOL_POLICY_EVIDENCE ??
      '.context/native-tool-policy-evidence.json',
  );
  const results = await Promise.allSettled([
    (async () => {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, JSON.stringify(evidence, null, 2) + '\n', {
        mode: 0o600,
      });
    })(),
    f?.close(),
    recovery?.close(),
  ]);
  cleanupErrors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  console.info(JSON.stringify({ toolPolicyEvidence: evidence }));
}
if (cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    'Tool policy proof or cleanup failed',
  );
if (failure) throw failure;
