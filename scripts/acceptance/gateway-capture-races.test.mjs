import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  createCaptureRegistry,
  capturedSpawn,
} from '../../test/acceptance/container/gateway-capture.mjs';
import { crashGateway } from '../../test/acceptance/container/gateway-crash.mjs';
import { gatewayArgs } from '../../test/acceptance/container/gateway-identity.mjs';
const identity = (patch = {}) => ({
  pid: 12345,
  group: 12345,
  start: '9001',
  state: 'S',
  uids: [1000, 1000, 1000, 1000],
  command: ['openclaw-gateway'],
  ...patch,
});
const options = { uid: 1000, gid: 1000, detached: true };
test('trusted initial ownership capture tolerates transient startup argv, but final exact title is mandatory', async () => {
  let reads = 0;
  const registry = createCaptureRegistry(async () =>
    identity({
      command:
        ++reads === 1
          ? ['synthetic-initial-exec-transition']
          : ['openclaw-gateway'],
    }),
  );
  registry.capture(12345);
  assert.deepEqual(await registry.target(), {
    pid: 12345,
    group: 12345,
    start: '9001',
  });
  const invalidFinal = createCaptureRegistry(async () =>
    identity({ command: ['unexpected-final-title'] }),
  );
  invalidFinal.capture(12345);
  await assert.rejects(
    invalidFinal.target(),
    (error) => error.code === 'cmdline-mismatch',
  );
});
test('original exit before metadata completion retires generation and rejects reused PID', async () => {
  let complete;
  const registry = createCaptureRegistry(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const child = Object.assign(new EventEmitter(), { pid: 12345 });
  const spawn = capturedSpawn(() => child, registry);
  spawn(process.execPath, gatewayArgs, options);
  child.emit('exit', 1);
  complete(identity({ start: 'new-process-start' }));
  await assert.rejects(
    registry.target(),
    (error) => error.code === 'no-captured-target',
  );
  const previous = process.env.MESSENGER_ACCEPTANCE_FIXTURE;
  process.env.MESSENGER_ACCEPTANCE_FIXTURE = '1';
  let signals = 0;
  try {
    await assert.rejects(crashGateway({ registry, kill: () => signals++ }));
    assert.equal(signals, 0);
  } finally {
    if (previous === undefined) delete process.env.MESSENGER_ACCEPTANCE_FIXTURE;
    else process.env.MESSENGER_ACCEPTANCE_FIXTURE = previous;
  }
});
test('old child exit cannot retire a newer exact spawn generation with same numeric PID', async () => {
  const registry = createCaptureRegistry(async () => identity());
  const old = Object.assign(new EventEmitter(), { pid: 12345 });
  const newer = Object.assign(new EventEmitter(), { pid: 12345 });
  const children = [old, newer];
  const spawn = capturedSpawn(() => children.shift(), registry);
  spawn(process.execPath, gatewayArgs, options);
  spawn(process.execPath, gatewayArgs, options);
  old.emit('exit', 1);
  assert.deepEqual(await registry.target(), {
    pid: 12345,
    group: 12345,
    start: '9001',
  });
  newer.emit('exit', 1);
  await assert.rejects(
    registry.target(),
    (error) => error.code === 'no-captured-target',
  );
});
test('initial wrong UID/group still fails even if a later process looks valid', async () => {
  let reads = 0;
  const registry = createCaptureRegistry(async () =>
    identity(++reads === 1 ? { uids: [0, 0, 0, 0] } : {}),
  );
  registry.capture(12345);
  await assert.rejects(
    registry.target(),
    (error) => error.code === 'uid-mismatch',
  );
});
