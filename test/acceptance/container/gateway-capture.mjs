import { rejectIdentity, crashCategory } from './gateway-diagnostic.mjs';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  matchesGatewaySpawn,
  gatewaySpawnShape,
  readProcess,
  assertGatewayIdentity,
  assertCapturedIdentity,
} from './gateway-identity.mjs';
export function createCaptureRegistry(read = readProcess) {
  const records = new Map();
  const shapes = [];
  let observed = 0,
    matched = 0;
  return {
    observe(shape) {
      observed++;
      if (Object.values(shape).every(Boolean)) matched++;
      shapes.push(shape);
      if (shapes.length > 4) shapes.shift();
    },
    diagnostics: () => ({
      observed,
      matched,
      shapes: shapes.map((shape) => ({ ...shape })),
    }),
    capture(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 1) return;
      const token = Symbol();
      const pending = read(pid)
        .then((value) => {
          const expected = { pid, group: value.group, start: value.start };
          assertCapturedIdentity(expected, value);
          return expected;
        })
        .catch((error) => ({
          rejected:
            crashCategory(error) === 'crash-operation-rejected'
              ? 'capture-unreadable'
              : crashCategory(error),
        }));
      records.set(pid, { token, pending, retired: false });
      return token;
    },
    retire(pid, token) {
      const record = records.get(pid);
      if (record?.token === token) record.retired = true;
    },
    async target() {
      const active = [];
      for (const [pid, record] of records) {
        if (record.retired) continue;
        const expected = await record.pending;
        if (record.retired || records.get(pid) !== record) continue;
        if (!expected || expected.rejected)
          rejectIdentity(expected?.rejected ?? 'capture-unreadable');
        let actual;
        try {
          actual = await read(expected.pid);
        } catch (error) {
          if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
          throw error;
        }
        if (
          record.retired ||
          records.get(pid) !== record ||
          actual.state === 'Z'
        )
          continue;
        assertGatewayIdentity(expected, actual);
        active.push(expected);
      }
      if (active.length !== 1)
        rejectIdentity(
          active.length ? 'ambiguous-target' : 'no-captured-target',
        );
      return active[0];
    },
  };
}
const retirement = (registry, pid, token) => () => registry.retire(pid, token);
export function capturedSpawn(spawn, registry) {
  return function (...args) {
    const child = spawn(...args);
    registry.observe?.(gatewaySpawnShape(...args));
    if (matchesGatewaySpawn(...args)) {
      const pid = child.pid;
      const token = registry.capture(pid);
      if (token) child.once('exit', retirement(registry, pid, token));
    }
    return child;
  };
}
export const gatewayCapture = createCaptureRegistry();
export function installGatewayCapture() {
  assert.equal(process.env.MESSENGER_ACCEPTANCE_FIXTURE, '1');
  childProcess.spawn = capturedSpawn(childProcess.spawn, gatewayCapture);
  syncBuiltinESMExports();
}
