import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupOwnedRuntime } from './cleanup.mjs';
const namespace = '123456abcdef';
const prefix = `workerd-openclaw-local-${namespace}-manager-ConversationManager-`;
const env = {
  CLOUDFLARE_WORKSPACE_ID: namespace,
  ACCEPTANCE_PROJECT: `messenger-acceptance-${namespace}`,
  ACCEPTANCE_ORIGIN: 'http://127.0.0.1:12345',
  ACCEPTANCE_HARNESS_ORIGIN: 'http://127.0.0.1:12346',
};
const stopped = { exitCode: 0, signalCode: null };
function fixture(fail = '') {
  const calls = [],
    containers = new Set(['owned-a', 'owned-b']);
  let failed = false,
    evidence;
  const effects = {
    async execute(command, args) {
      assert.equal(command, 'docker');
      calls.push(args.join(' '));
      if (args[0] === 'ps' && args[1] === '-q')
        return { stdout: 'unrelated\n' };
      if (args[0] === 'ps') {
        assert.equal(args.at(-1), `name=${prefix}`);
        if (fail === 'list' && !failed) {
          failed = true;
          throw Error('simulated ps timeout');
        }
        return { stdout: [...containers].join('\n') };
      }
      const id = args.at(-1);
      if (args[0] === 'inspect') {
        if (fail === 'inspect' && id === 'owned-a' && !failed) {
          failed = true;
          throw Error('simulated inspect timeout');
        }
        return {
          stdout: `/${id === 'owned-a' && fail === 'foreign' ? 'unrelated-container' : `${prefix}${id}`}\n`,
        };
      }
      assert.equal(args[0], 'rm');
      if (fail === 'remove' && id === 'owned-a' && !failed) {
        failed = true;
        throw Error('simulated rm timeout');
      }
      containers.delete(id);
      return { stdout: '' };
    },
    async portClosed(origin) {
      calls.push(`port ${origin}`);
      return true;
    },
    async delay() {},
    async writeFile(path, data, options) {
      assert.equal(options.mode, 0o600);
      evidence = JSON.parse(data);
      calls.push('evidence');
    },
  };
  return { effects, calls, containers, evidence: () => evidence };
}
test('successful cleanup verifies exact absence, both ports and unrelated baseline', async () => {
  const f = fixture();
  const result = await cleanupOwnedRuntime(
    stopped,
    env,
    ['unrelated'],
    '/unused',
    f.effects,
  );
  assert.equal(result.ownedAbsent, true);
  assert.equal(result.preexistingStillRunning, true);
  assert.equal(result.portsClosed.length, 2);
  assert.equal(f.containers.size, 0);
  assert.equal(f.calls.filter((call) => call.startsWith('ps -aq')).length, 3);
});
for (const failure of ['list', 'inspect', 'remove']) {
  test(`${failure} failure still attempts independent removals, ports, baseline and evidence; error propagates`, async () => {
    const f = fixture(failure);
    await assert.rejects(
      cleanupOwnedRuntime(stopped, env, ['unrelated'], '/unused', f.effects),
      AggregateError,
    );
    assert.equal(
      f.containers.size,
      0,
      'Second exact pass must finish retained owned resources',
    );
    assert.ok(
      f.calls.includes('rm -f owned-b'),
      'Unrelated cleanup steps must continue',
    );
    assert.equal(f.calls.filter((call) => call.startsWith('port ')).length, 2);
    assert.ok(f.calls.includes('ps -q'));
    assert.equal(f.evidence().ownedAbsent, true);
    assert.equal(f.evidence().preexistingStillRunning, true);
    assert.ok(f.evidence().cleanupFailureSteps.length > 0);
  });
}
test('foreign names are never removed and unknown final ownership fails cleanup', async () => {
  const f = fixture('foreign');
  await assert.rejects(
    cleanupOwnedRuntime(stopped, env, ['unrelated'], '/unused', f.effects),
    AggregateError,
  );
  assert.equal(f.calls.includes('rm -f owned-a'), false);
  assert.equal(f.calls.includes('rm -f owned-b'), true);
  assert.equal(f.evidence().ownedAbsent, false);
  assert.equal(f.evidence().portsClosed.length, 2);
});
test('runner shutdown failure does not bypass owned resource cleanup', async () => {
  const f = fixture();
  const runner = {
    exitCode: null,
    signalCode: null,
    kill() {
      throw Error('simulated signal failure');
    },
  };
  await assert.rejects(
    cleanupOwnedRuntime(runner, env, ['unrelated'], '/unused', f.effects),
    AggregateError,
  );
  assert.equal(f.evidence().ownedAbsent, true);
  assert.ok(f.evidence().cleanupFailureSteps.includes('runner-shutdown'));
});
test('open first listener and missing baseline still check second listener and write evidence', async () => {
  const f = fixture();
  f.effects.portClosed = async (origin) => {
    f.calls.push(`port ${origin}`);
    return origin === env.ACCEPTANCE_HARNESS_ORIGIN;
  };
  await assert.rejects(
    cleanupOwnedRuntime(stopped, env, ['missing'], '/unused', f.effects),
    AggregateError,
  );
  assert.equal(f.evidence().portsClosed[0].closed, false);
  assert.equal(f.evidence().portsClosed[1].closed, true);
  assert.equal(f.evidence().preexistingStillRunning, false);
});
