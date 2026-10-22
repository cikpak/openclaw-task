import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyFallbackProof } from './fallback-proof.mjs';
import { fallbackContext } from './fallback-context.mjs';
import {
  validateFallbackRecords,
  verifyFallbackCoverage,
} from './fallback-coverage.mjs';
const namespace = '123456abcdef';
function message(role, fields = {}) {
  return {
    role,
    stableId: true,
    positiveSequence: true,
    exactInputKey: false,
    steerTargetPresent: false,
    steerTargetMatchesParent: false,
    runMatchesInput: false,
    runMatchesParent: false,
    newerThanLinkedUser: false,
    processingShapeValid: false,
    processingIncludesInput: false,
    processingOwnerMatchesInput: false,
    processingOwnerMatchesParent: false,
    processingOwnerDiffersInputAndParent: false,
    latestProcessingUser: false,
    runMatchesProcessingOwner: false,
    newerThanProcessingUser: false,
    hasToolCall: false,
    requestFailed: false,
    isError: false,
    hasError: false,
    hasErrorMessage: false,
    stopReason: 'absent',
    channel: 'absent',
    ...fields,
  };
}
function proof(generated = true) {
  return {
    accepted: true,
    nativeReady: true,
    queryScoped: true,
    storedScopePresent: true,
    responseSessionMatchesStoredScope: true,
    processingMalformed: false,
    processingContradiction: false,
    inFlightPresent: false,
    inFlightMatchesProcessingOwner: false,
    pendingState: null,
    processingAssociationPresent: generated,
    processingOwnerDiffersInputAndParent: generated,
    processingAssociatedSequenceCount: generated ? 1 : 0,
    messages: [
      message('user', {
        exactInputKey: true,
        processingShapeValid: generated,
        processingIncludesInput: generated,
        latestProcessingUser: generated,
        processingOwnerDiffersInputAndParent: generated,
      }),
      message('assistant', {
        stopReason: 'stop',
        runMatchesProcessingOwner: generated,
        newerThanProcessingUser: generated,
        newerThanLinkedUser: true,
        runMatchesInput: !generated,
      }),
    ],
  };
}
const record = (project, value = proof()) => ({
  namespace,
  project,
  ...classifyFallbackProof(value),
});
function environment(cwd) {
  const stateDir = join(cwd, '.context', `acceptance-${namespace}`);
  return {
    CLOUDFLARE_WORKSPACE_ID: namespace,
    ACCEPTANCE_PROJECT: `messenger-acceptance-${namespace}`,
    CLOUDFLARE_STATE_DIR: stateDir,
    ACCEPTANCE_RUNTIME_FILE: join(stateDir, 'runtime.json'),
    CLOUDFLARE_PORT: '12345',
    ACCEPTANCE_HARNESS_ORIGIN: 'http://127.0.0.1:12345',
  };
}
test('strict generated owner proof emits only the safe whitelist', () => {
  const value = proof();
  value.secretFutureField = 'never serialize this';
  value.messages[0].nativeIdentity = 'never serialize this either';
  const summary = classifyFallbackProof(value);
  assert.equal(summary.kind, 'generated-owner');
  assert.equal(summary.association, 'generated-owner');
  assert.equal(JSON.stringify(summary).includes('never serialize'), false);
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      'kind',
      'association',
      'accepted',
      'queryScoped',
      'pendingCleared',
      'nativeInactive',
      'causalSuccessfulFinal',
      'scopeStatus',
      'canonicalInputCount',
      'processingSequenceCount',
    ].sort(),
  );
});
test('direct and confirmed true-Steer are valid but UNSUITABLE fallback samples', () => {
  const direct = proof(false);
  assert.equal(classifyFallbackProof(direct).association, 'direct-input');
  direct.messages[0].steerTargetPresent = true;
  direct.messages[0].steerTargetMatchesParent = true;
  direct.messages[1].runMatchesInput = false;
  direct.messages[1].runMatchesParent = true;
  assert.equal(classifyFallbackProof(direct).association, 'confirmed-steer');
  assert.equal(classifyFallbackProof(direct).kind, 'UNSUITABLE');
});
test('explicit processing owner equal to original parent is UNSUITABLE', () => {
  const value = proof();
  value.processingOwnerDiffersInputAndParent = false;
  value.messages[0].processingOwnerDiffersInputAndParent = false;
  value.messages[0].processingOwnerMatchesParent = true;
  assert.equal(
    classifyFallbackProof(value).association,
    'explicit-original-owner',
  );
  assert.equal(classifyFallbackProof(value).kind, 'UNSUITABLE');
});
test('incomplete, malformed and incorrectly typed oracle responses fail closed', () => {
  for (const field of [
    'nativeReadFailed',
    'historyChanged',
    'scanIncomplete',
    'paginationInvalid',
    'processingMalformed',
    'processingContradiction',
  ]) {
    const value = proof();
    value[field] = true;
    assert.throws(() => classifyFallbackProof(value));
  }
  for (const field of [
    'queryScoped',
    'responseSessionMatchesStoredScope',
    'nativeReady',
  ]) {
    const value = proof();
    delete value[field];
    assert.throws(() => classifyFallbackProof(value));
  }
  const value = proof();
  value.messages[1].hasToolCall = 'false';
  assert.throws(() => classifyFallbackProof(value));
});
test('partial, failed, noncausal, unmatched and active outcomes cannot supply proof', () => {
  for (const change of [
    { stopReason: 'aborted' },
    { channel: 'commentary' },
    { hasToolCall: true },
    { requestFailed: true },
    { isError: true },
    { hasError: true },
    { hasErrorMessage: true },
    { runMatchesProcessingOwner: false },
    { newerThanProcessingUser: false },
    { stableId: false },
  ]) {
    const value = proof();
    Object.assign(value.messages[1], change);
    assert.throws(() => classifyFallbackProof(value));
  }
  for (const change of [
    { pendingState: 'unknown' },
    { inFlightPresent: true },
    { inFlightMatchesProcessingOwner: true },
  ])
    assert.throws(() => classifyFallbackProof({ ...proof(), ...change }));
  const unassociated = proof(false);
  unassociated.messages[1].runMatchesInput = false;
  assert.throws(() => classifyFallbackProof(unassociated));
});
test('both layouts mandatory; zero random generated samples reports uncovered without failing', () => {
  assert.equal(
    validateFallbackRecords(
      [record('desktop', proof(false)), record('mobile', proof(false))],
      namespace,
    ).generatedCoverage,
    'UNSUITABLE/uncovered',
  );
  assert.equal(
    validateFallbackRecords(
      [record('desktop'), record('mobile', proof(false))],
      namespace,
    ).generatedSamples,
    1,
  );
  assert.throws(() => validateFallbackRecords([record('desktop')], namespace));
  assert.throws(() =>
    validateFallbackRecords([record('desktop'), record('desktop')], namespace),
  );
  assert.throws(() =>
    validateFallbackRecords(
      [record('desktop'), { ...record('mobile'), namespace: 'ffffffffffff' }],
      namespace,
    ),
  );
  assert.throws(() =>
    validateFallbackRecords(
      [
        record('desktop'),
        { ...record('mobile'), causalSuccessfulFinal: false },
      ],
      namespace,
    ),
  );
});
test('context rejects foreign state/runtime/origins before any private read', () => {
  const env = environment('/tmp/acceptance-unit');
  assert.equal(
    fallbackContext(env, '/tmp/acceptance-unit').namespace,
    namespace,
  );
  for (const change of [
    { CLOUDFLARE_STATE_DIR: '/tmp/other' },
    { ACCEPTANCE_RUNTIME_FILE: '/tmp/other/runtime.json' },
    { ACCEPTANCE_HARNESS_ORIGIN: 'https://example.com' },
    { CLOUDFLARE_WORKSPACE_ID: '../outside' },
    { ACCEPTANCE_PROJECT: 'other' },
  ])
    assert.throws(() =>
      fallbackContext({ ...env, ...change }, '/tmp/acceptance-unit'),
    );
});
test('artifact reader uses only current namespace and fails a missing layout', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'fallback-unit-'));
  const prior = process.cwd();
  try {
    process.chdir(cwd);
    const env = environment(process.cwd());
    const directory = fallbackContext(env).directory;
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'desktop.json'),
      JSON.stringify(record('desktop')),
    );
    await assert.rejects(verifyFallbackCoverage(env));
    await writeFile(
      join(directory, 'mobile.json'),
      JSON.stringify(record('mobile', proof(false))),
    );
    assert.equal((await verifyFallbackCoverage(env)).generatedSamples, 1);
    await assert.rejects(
      verifyFallbackCoverage({
        ...env,
        CLOUDFLARE_WORKSPACE_ID: 'ffffffffffff',
        ACCEPTANCE_PROJECT: 'messenger-acceptance-ffffffffffff',
      }),
    );
  } finally {
    process.chdir(prior);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('completed scope cleanup is explicit; retained mismatch and malformed flags fail', () => {
  const value = proof();
  value.storedScopePresent = false;
  value.responseSessionMatchesStoredScope = false;
  assert.equal(
    classifyFallbackProof(value).scopeStatus,
    'not-retained-after-settlement',
  );
  for (const change of [
    { storedScopePresent: true },
    { responseSessionMatchesStoredScope: true },
    { storedScopePresent: undefined },
    { responseSessionMatchesStoredScope: 'false' },
    { pendingState: 'unknown' },
  ])
    assert.throws(() => classifyFallbackProof({ ...value, ...change }));
});
