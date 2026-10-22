import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capturedSpawn,
  createCaptureRegistry,
} from '../../test/acceptance/container/gateway-capture.mjs';
import { restartGateway } from '../../apps/cloudflare/test/acceptance-restart.ts';
test('spawn diagnostics are bounded fixed booleans without original arguments/options', () => {
  const registry = createCaptureRegistry();
  const spawn = capturedSpawn(() => ({ pid: undefined }), registry);
  for (let i = 0; i < 10; i++)
    spawn('private-node-path', ['private-args'], {
      env: { SECRET: 'private-value' },
    });
  const diagnostic = registry.diagnostics();
  assert.equal(diagnostic.observed, 10);
  assert.equal(diagnostic.matched, 0);
  assert.equal(diagnostic.shapes.length, 4);
  assert.equal(JSON.stringify(diagnostic).includes('private'), false);
  for (const shape of diagnostic.shapes) {
    assert.deepEqual(Object.keys(shape).sort(), [
      'argv',
      'detached',
      'exec',
      'gid',
      'uid',
    ]);
    assert.ok(
      Object.values(shape).every((value) => typeof value === 'boolean'),
    );
  }
});
test('test entry projects finite diagnostic fields and rejects unknown phase/category', async () => {
  const response = await restartGateway({
    action: async () => ({
      crashed: false,
      category: 'cmdline-mismatch',
      phase: 'capture',
      capture: {
        observed: 1,
        matched: 0,
        secret: 'private-value',
        shapes: [
          {
            exec: true,
            argv: false,
            uid: true,
            gid: true,
            detached: true,
            secret: 'private-value',
          },
        ],
      },
    }),
    health: async () => ({ gatewayState: 'running' }),
  });
  const result = await response.json();
  assert.equal(result.reason, 'cmdline-mismatch');
  assert.equal(result.crashPhase, 'capture');
  assert.equal(result.capture.observed, 1);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
  const unknown = await restartGateway({
    action: async () => ({
      crashed: false,
      category: 'private-value',
      phase: 'private-value',
    }),
    health: async () => ({ gatewayState: 'private-value' }),
  });
  const rejected = await unknown.json();
  assert.equal(rejected.reason, 'crash-operation-rejected');
  assert.equal(rejected.crashPhase, 'unavailable');
  assert.equal(rejected.gatewayState, 'unavailable');
  assert.equal(JSON.stringify(rejected).includes('private-value'), false);
});
