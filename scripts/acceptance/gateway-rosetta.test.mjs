import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGatewayIdentity } from '../../test/acceptance/container/gateway-identity.mjs';
const measured = [
  '/run/rosetta/rosetta',
  process.execPath,
  process.execPath,
  '--no-opt',
  '-r',
  '/proc/.reset',
  '/app/openclaw.mjs',
  'gateway',
  '--bind',
  'lan',
  '--port',
  '18789',
];
const expected = { pid: 12345, group: 12345, start: '9001' };
const actual = (command) => ({
  ...expected,
  state: 'S',
  uids: [1000, 1000, 1000, 1000],
  command,
});
test('complete measured emulation vector accepts only the exact pinned Gateway invocation', () => {
  assert.doesNotThrow(() => assertGatewayIdentity(expected, actual(measured)));
  for (let index = 0; index < measured.length; index++) {
    const changed = [...measured];
    changed[index] = 'altered-token';
    assert.throws(() => assertGatewayIdentity(expected, actual(changed)));
    const removed = measured.filter((_, position) => position !== index);
    assert.throws(() => assertGatewayIdentity(expected, actual(removed)));
  }
  for (const command of [
    [...measured, 'extra'],
    ['extra', ...measured],
    [...measured.slice(0, 6), 'openclaw-gateway'],
    [...measured.slice(0, 6), '/app/other.mjs', ...measured.slice(7)],
  ])
    assert.throws(() => assertGatewayIdentity(expected, actual(command)));
});
test('measured emulator vector still requires same PID/start/group and UID ownership', () => {
  for (const change of [
    { start: '9002' },
    { group: 23456 },
    { uids: [0, 0, 0, 0] },
  ])
    assert.throws(() =>
      assertGatewayIdentity(expected, { ...actual(measured), ...change }),
    );
});
