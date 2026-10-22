import { rejectIdentity } from './gateway-diagnostic.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
export const gatewayArgs = [
  '/app/openclaw.mjs',
  'gateway',
  '--bind',
  'lan',
  '--port',
  '18789',
];
export function gatewaySpawnShape(command, args, options) {
  return {
    exec: command === process.execPath,
    argv:
      Array.isArray(args) &&
      args.length === gatewayArgs.length &&
      args.every((value, index) => value === gatewayArgs[index]),
    uid: options?.uid === 1000,
    gid: options?.gid === 1000,
    detached: options?.detached === true,
  };
}
export const matchesGatewaySpawn = (...args) =>
  Object.values(gatewaySpawnShape(...args)).every(Boolean);
export async function readProcess(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const directory = `/proc/${pid}`;
  const [stat, status, command] = await Promise.all([
    readFile(`${directory}/stat`, 'utf8'),
    readFile(`${directory}/status`, 'utf8'),
    readFile(`${directory}/cmdline`),
  ]);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    pid,
    group: Number(fields[2]),
    start: fields[19],
    state: fields[0],
    uids: /^Uid:\s+(.+)$/mu.exec(status)?.[1].trim().split(/\s+/u).map(Number),
    command: command.toString().split('\0').filter(Boolean),
  };
}
export function assertCapturedIdentity(expected, actual) {
  if (actual.pid !== expected.pid) rejectIdentity('pid-mismatch');
  if (actual.group !== expected.group) rejectIdentity('group-mismatch');
  if (actual.group !== actual.pid) rejectIdentity('pid-group-mismatch');
  if (actual.start !== expected.start) rejectIdentity('start-reused');
  if (typeof actual.start !== 'string' || !/^[0-9]+$/u.test(actual.start))
    rejectIdentity('start-invalid');
  if (actual.state === 'Z') rejectIdentity('zombie');
  if (!(actual.uids?.length === 4 && actual.uids.every((uid) => uid === 1000)))
    rejectIdentity('uid-mismatch');
}
export function assertGatewayIdentity(expected, actual) {
  assertCapturedIdentity(expected, actual);
  const original = [process.execPath, ...gatewayArgs];
  const exactArgv =
    actual.command.length === original.length &&
    actual.command.every((value, index) => value === original[index]);
  const exactTitle =
    actual.command.length === 1 &&
    ['openclaw', 'openclaw-gateway'].includes(actual.command[0]);
  // Exact vector measured in the immutable AMD64 acceptance image on Rosetta.
  const emulated = [
    '/run/rosetta/rosetta',
    process.execPath,
    process.execPath,
    '--no-opt',
    '-r',
    '/proc/.reset',
    ...gatewayArgs,
  ];
  const exactRosetta =
    actual.command.length === emulated.length &&
    actual.command.every((value, index) => value === emulated[index]);
  if (!exactArgv && !exactTitle && !exactRosetta)
    rejectIdentity('cmdline-mismatch');
}
