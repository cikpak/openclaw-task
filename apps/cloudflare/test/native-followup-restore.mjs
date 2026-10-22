import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { objects as recoveryObjects } from '../container/objects.mjs';
export async function restoreFixture({
  gateway,
  control,
  identity,
  start,
  recovery,
}) {
  const { job, docker } = control;
  await gateway.stop();
  await job('stop');
  const checkpointId = randomUUID(),
    descriptor = await job('capture', { checkpointId });
  const objects = recoveryObjects(descriptor);
  const upload = await job('upload', {
    checkpointId,
    grants: await recovery.grants(descriptor, 'PUT'),
    readbackGrants: await recovery.grants(descriptor, 'GET'),
  });
  assert.equal(upload.uploaded, true);
  assert.equal(upload.verification.count, objects.length);
  await docker(['stop', '--time', '30', control.name()]);
  await control.launch(identity, true);
  const result = await job('restore', {
    descriptor,
    grants: await recovery.grants(descriptor, 'GET'),
  });
  assert.equal(result.restored, true);
  assert.equal(result.inventoryDigest, descriptor.inventoryDigest);
  await start();
  return descriptor;
}
