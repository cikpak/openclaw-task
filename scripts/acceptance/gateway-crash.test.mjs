import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  gatewayArgs,
  matchesGatewaySpawn,
  assertGatewayIdentity,
} from '../../test/acceptance/container/gateway-identity.mjs';
import {
  createCaptureRegistry,
  capturedSpawn,
} from '../../test/acceptance/container/gateway-capture.mjs';
import { crashGateway } from '../../test/acceptance/container/gateway-crash.mjs';
import { restartGateway } from '../../apps/cloudflare/test/acceptance-restart.ts';
const expected = { pid: 12345, group: 12345, start: '9001' };
const actual = (patch = {}) => ({
  ...expected,
  state: 'S',
  uids: [1000, 1000, 1000, 1000],
  command: ['openclaw-gateway'],
  ...patch,
});
const options = {
  uid: 1000,
  gid: 1000,
  detached: true,
  stdio: 'ignore',
  env: { SYNTHETIC_PRIVATE: 'do-not-retain' },
};
test('spawn capture delegates exact original arguments/options and retains only identity', async () => {
  const calls = [],
    registry = createCaptureRegistry(async () => actual());
  const child = Object.assign(new EventEmitter(), { pid: expected.pid });
  const spawn = capturedSpawn((...args) => {
    calls.push(args);
    return child;
  }, registry);
  assert.equal(spawn(process.execPath, gatewayArgs, options), child);
  assert.equal(calls[0][1], gatewayArgs);
  assert.equal(calls[0][2], options);
  assert.deepEqual(await registry.target(), expected);
  assert.deepEqual(Object.keys(await registry.target()).sort(), [
    'group',
    'pid',
    'start',
  ]);
});
test('spawn signature rejects command substrings, extra arguments, wrong credentials and nondetached children', () => {
  assert.equal(
    matchesGatewaySpawn(process.execPath, gatewayArgs, options),
    true,
  );
  for (const [command, args, opts] of [
    ['other-node', gatewayArgs, options],
    [process.execPath, [...gatewayArgs, 'extra'], options],
    [process.execPath, ['/app/openclaw.mjs', 'devices', 'list'], options],
    [process.execPath, gatewayArgs, { ...options, uid: 0 }],
    [process.execPath, gatewayArgs, { ...options, gid: 0 }],
    [process.execPath, gatewayArgs, { ...options, detached: false }],
  ])
    assert.equal(matchesGatewaySpawn(command, args, opts), false);
});
test('only exact pinned argv or known exact native titles pass', () => {
  for (const command of [
    [process.execPath, ...gatewayArgs],
    ['openclaw'],
    ['openclaw-gateway'],
  ])
    assert.doesNotThrow(() =>
      assertGatewayIdentity(expected, actual({ command })),
    );
  for (const command of [
    ['not-openclaw-gateway'],
    ['openclaw-gateway', 'extra'],
    ['openclaw-gateway-evil'],
    [process.execPath, ...gatewayArgs, 'extra'],
  ])
    assert.throws(() => assertGatewayIdentity(expected, actual({ command })));
});
test('identity rejects PID reuse, wrong group/UID, zombies and missing start time', () => {
  for (const patch of [
    { pid: 54321 },
    { group: 54321 },
    { start: '9002' },
    { start: undefined },
    { uids: [1000, 0, 1000, 1000] },
    { uids: [1000] },
    { state: 'Z' },
  ])
    assert.throws(() => assertGatewayIdentity(expected, actual(patch)));
});
test('registry rejects ambiguous captured groups and reused captured PIDs', async () => {
  const registry = createCaptureRegistry(async (pid) =>
    actual({ pid, group: pid }),
  );
  registry.capture(12345);
  registry.capture(23456);
  await assert.rejects(registry.target());
  let reads = 0;
  const reused = createCaptureRegistry(async () =>
    actual({ start: ++reads === 1 ? '9001' : '9002' }),
  );
  reused.capture(12345);
  await assert.rejects(reused.target());
});
test('capture does not include nonmatching subprocesses', () => {
  const captures = [];
  const spawn = capturedSpawn(() => ({ pid: 12345 }), {
    capture: (pid) => captures.push(pid),
  });
  spawn(process.execPath, ['unrelated'], options);
  assert.deepEqual(captures, []);
});
async function fixture(action) {
  const previous = process.env.MESSENGER_ACCEPTANCE_FIXTURE;
  process.env.MESSENGER_ACCEPTANCE_FIXTURE = '1';
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.MESSENGER_ACCEPTANCE_FIXTURE;
    else process.env.MESSENGER_ACCEPTANCE_FIXTURE = previous;
  }
}
test('crash kills only the revalidated captured group and verifies all writers afterward', async () =>
  fixture(async () => {
    const calls = [];
    assert.deepEqual(
      await crashGateway({
        registry: { target: async () => expected },
        readProcess: async () => actual(),
        kill: (...args) => calls.push(args),
        members: async () => [],
        verify: async () => calls.push('verified'),
      }),
      { crashed: true, remainingWriters: 0 },
    );
    assert.deepEqual(calls, [[-12345, 'SIGKILL'], 'verified']);
  }));
test('reused or wrong crash identity rejects before any signal; verification failure propagates', async () =>
  fixture(async () => {
    let killed = 0;
    const effects = {
      registry: { target: async () => expected },
      readProcess: async () => actual({ start: '9002' }),
      kill: () => killed++,
      members: async () => [],
      verify: async () => {},
    };
    await assert.rejects(crashGateway(effects));
    assert.equal(killed, 0);
    effects.readProcess = async () => actual();
    effects.verify = async () => {
      throw Error('writers remain');
    };
    await assert.rejects(crashGateway(effects));
    assert.equal(killed, 1);
  }));
test('acceptance restart uses crash then natural monitor settlement then ordinary start', async () => {
  const actions = [];
  const response = await restartGateway({
    action: async (name) => {
      actions.push(name);
      return { crashed: true };
    },
    health: async () => ({ gatewayState: 'stopped' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(actions, ['acceptance-crash', 'start']);
});
test('failed crash never starts a replacement and emits only safe stage evidence', async () => {
  const actions = [];
  const response = await restartGateway({
    action: async (name) => {
      actions.push(name);
      throw Error('private payload must not escape');
    },
    health: async () => ({ gatewayState: 'failed' }),
  });
  const value = await response.json();
  assert.equal(response.status, 500);
  assert.equal(value.stage, 'crash');
  assert.equal(value.gatewayState, 'failed');
  assert.equal(JSON.stringify(value).includes('private payload'), false);
  assert.deepEqual(actions, ['acceptance-crash']);
});
test('production Docker context and entrypoints exclude acceptance crash/capture modules', async () => {
  const root = resolve(import.meta.dirname, '../..');
  const workers = await readFile(
    resolve(root, 'apps/cloudflare/config/workers.ts'),
    'utf8',
  );
  assert.match(workers, /dockerfile:\s*'\.\/container\/Dockerfile'/u);
  assert.doesNotMatch(workers, /test\/acceptance/u);
  const production = await readFile(
    resolve(root, 'apps/cloudflare/container/Dockerfile'),
    'utf8',
  );
  assert.match(production, /NODE_ENV=production/u);
  assert.doesNotMatch(
    production,
    /MESSENGER_ACCEPTANCE_FIXTURE|test\/acceptance|gateway-capture|jobs\.production/u,
  );
  const files = await readdir(resolve(root, 'apps/cloudflare/container'));
  for (const name of [
    'gateway-capture.mjs',
    'gateway-crash.mjs',
    'gateway-identity.mjs',
    'gateway-diagnostic.mjs',
    'gateway-writer-evidence.mjs',
    'gateway-writer-wait.mjs',
    'jobs.production.mjs',
  ])
    assert.equal(files.includes(name), false);
  const acceptance = await readFile(
    resolve(root, 'test/acceptance/Dockerfile'),
    'utf8',
  );
  assert.match(acceptance, /MESSENGER_ACCEPTANCE_FIXTURE=1/u);
  assert.match(acceptance, /jobs\.production\.mjs/u);
});
test('unexpected final command emits fixed category without retaining process data', async () => {
  const registry = createCaptureRegistry(async () =>
    actual({ command: ['private-unexpected-command'] }),
  );
  registry.capture(expected.pid);
  await assert.rejects(
    registry.target(),
    (error) =>
      error.code === 'cmdline-mismatch' &&
      !error.message.includes('private-unexpected-command'),
  );
});
test('logical crash rejection cannot start replacement and only allowlisted reason escapes', async () => {
  for (const category of [
    'cmdline-mismatch',
    'private unexpected native error',
  ]) {
    const calls = [];
    const response = await restartGateway({
      action: async (name) => {
        calls.push(name);
        return { crashed: false, category };
      },
      health: async () => ({ gatewayState: 'running' }),
    });
    const value = await response.json();
    assert.equal(response.status, 500);
    assert.equal(
      value.reason,
      category === 'cmdline-mismatch' ? category : 'crash-operation-rejected',
    );
    assert.deepEqual(calls, ['acceptance-crash']);
  }
});
