import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupOwnedRuntime } from './cleanup.mjs';
import { dockerFailure } from './cleanup-containers.mjs';
const namespace = '123456abcdef';
const prefix = `workerd-openclaw-local-${namespace}-manager-ConversationManager-`;
const env = {
  CLOUDFLARE_WORKSPACE_ID: namespace,
  ACCEPTANCE_PROJECT: `messenger-acceptance-${namespace}`,
  ACCEPTANCE_ORIGIN: 'http://127.0.0.1:12345',
  ACCEPTANCE_HARNESS_ORIGIN: 'http://127.0.0.1:12346',
};
const daemon = (stderr) =>
  Object.assign(Error('Docker command failed'), { code: 1, stderr });
const progress = () =>
  daemon(
    'Error response from daemon: removal of container owned is already in progress\n',
  );
const missing = () => daemon('Error: No such object: owned\n');
function fixture(mode) {
  let time = 0,
    present = true,
    evidence;
  const calls = [];
  const effects = {
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
    portClosed: async () => true,
    writeFile: async (_path, value) => {
      evidence = JSON.parse(value);
    },
    execute: async (command, args) => {
      assert.equal(command, 'docker');
      calls.push([...args]);
      if (args[0] === 'ps' && args[1] === '-q') return { stdout: 'baseline\n' };
      if (args[0] === 'ps') {
        assert.equal(args.at(-1), `name=${prefix}`);
        return { stdout: present ? 'owned\n' : '' };
      }
      assert.equal(
        args.at(-1),
        'owned',
        'Never act on the baseline or another ID',
      );
      if (args[0] === 'inspect') {
        if (mode === 'missing-inspect') {
          present = false;
          throw missing();
        }
        return { stdout: `/${prefix}native\n` };
      }
      assert.deepEqual(args, ['rm', '-f', 'owned']);
      if (mode === 'missing-remove') {
        present = false;
        throw daemon('Error response from daemon: No such container: owned');
      }
      if (mode === 'permanent') {
        present = false;
        throw daemon('Error response from daemon: permission denied');
      }
      if (mode === 'stuck' || time < (mode === 'slow-settles' ? 30_250 : 750))
        throw progress();
      present = false;
      return { stdout: '' };
    },
  };
  return { effects, calls, evidence: () => evidence, time: () => time };
}
const cleanup = (f) =>
  cleanupOwnedRuntime(
    { exitCode: 0, signalCode: null },
    env,
    ['baseline'],
    '/unused',
    f.effects,
  );
test('Docker asynchronous removal settles beyond two immediate passes and still proves all cleanup invariants', async () => {
  const f = fixture('settles');
  const result = await cleanup(f);
  assert.equal(f.time(), 750);
  assert.equal(result.ownedAbsent, true);
  assert.equal(result.preexistingStillRunning, true);
  assert.deepEqual(
    result.portsClosed.map((port) => port.closed),
    [true, true],
  );
  assert.deepEqual(result.cleanupFailureSteps, []);
  assert.deepEqual(
    result.dockerObservations.map((row) => row.category),
    Array(3).fill('removal-in-progress'),
  );
  assert.equal(f.calls.filter((args) => args[0] === 'rm').length, 4);
  assert.equal(f.calls.filter((args) => args[0] === 'inspect').length, 4);
});
test('known Docker removal just beyond thirty seconds settles without relaxing final cleanup proofs', async () => {
  const f = fixture('slow-settles');
  const result = await cleanup(f);
  assert.equal(f.time(), 30_250);
  assert.equal(result.ownedAbsent, true);
  assert.equal(result.preexistingStillRunning, true);
  assert.deepEqual(
    result.portsClosed.map((port) => port.closed),
    [true, true],
  );
  assert.deepEqual(result.cleanupFailureSteps, []);
  assert.equal(result.dockerObservations.length, 64);
  assert.ok(
    result.dockerObservations.every(
      (row) => row.category === 'removal-in-progress',
    ),
  );
});
for (const mode of ['missing-inspect', 'missing-remove'])
  test(`${mode} concurrent Miniflare deletion is accepted only after final absence`, async () => {
    const f = fixture(mode);
    const result = await cleanup(f);
    assert.equal(result.ownedAbsent, true);
    assert.equal(result.preexistingStillRunning, true);
    assert.deepEqual(result.cleanupFailureSteps, []);
    assert.deepEqual(
      result.dockerObservations.map((row) => row.category),
      ['not-found'],
    );
    if (mode === 'missing-inspect')
      assert.equal(
        f.calls.some((args) => args[0] === 'rm'),
        false,
      );
  });
test('permanent Docker failure stays visible even when a later inventory is empty', async () => {
  const f = fixture('permanent');
  await assert.rejects(cleanup(f), AggregateError);
  assert.equal(f.evidence().ownedAbsent, true);
  assert.deepEqual(f.evidence().cleanupFailureSteps, ['owned-remove']);
  assert.equal(f.evidence().dockerObservations[0].category, 'other');
});
test('removal still in progress at bounded deadline fails, preserves baseline and writes finite evidence', async () => {
  const f = fixture('stuck');
  await assert.rejects(cleanup(f), AggregateError);
  assert.equal(f.time(), 60_000);
  assert.equal(f.evidence().ownedAbsent, false);
  assert.deepEqual(f.evidence().cleanupFailureSteps, [
    'owned-still-present-or-unknown',
  ]);
  assert.equal(f.evidence().preexistingStillRunning, true);
  assert.equal(f.evidence().portsClosed.length, 2);
  assert.equal(f.evidence().dockerObservations.length, 64);
  assert.ok(f.calls.filter((args) => args[0] === 'rm').length < 245);
});
test('only exact daemon categories qualify; timeout, permission and lookalikes never acquire transient status', () => {
  assert.equal(dockerFailure(progress()), 'removal-in-progress');
  assert.equal(dockerFailure(missing()), 'not-found');
  for (const error of [
    Error(
      'Error response from daemon: removal of container owned is already in progress',
    ),
    daemon(
      'Error response from daemon: removal of container owned is already in progress extra',
    ),
    daemon('Error response from daemon: permission denied'),
    Object.assign(progress(), { code: 2 }),
  ])
    assert.equal(dockerFailure(error), 'other');
  assert.equal(
    dockerFailure(
      Object.assign(progress(), { killed: true, signal: 'SIGKILL' }),
    ),
    'timeout',
  );
});
