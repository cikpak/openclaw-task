import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createJobs } from '../container/jobs.mjs';
import { objects, grantsFor } from '../container/objects.mjs';
import { auditConfig, defaults } from '../container/configuration.mjs';
import { validateIdentity } from '../container/identity.mjs';
const turn = () => new Promise((resolve) => setImmediate(resolve));
test('stable boot and request fence; unknown cancellation tombstone blocks a late start', async () => {
  let calls = 0;
  const jobs = createJobs('boot', {
    capture: async () => {
      calls++;
      return { captured: true };
    },
  });
  const payload = { bootId: 'boot', operationId: 'capture', action: 'capture' };
  assert.equal(jobs.start({ ...payload, bootId: 'old' }).code, 400);
  assert.equal(jobs.cancel('capture').status, 'cancelled');
  assert.equal(jobs.start(payload).value.status, 'cancelled');
  await turn();
  assert.equal(calls, 0);
  const other = { ...payload, operationId: 'other' };
  assert.equal(jobs.start(other).code, 202);
  await turn();
  assert.equal(jobs.start(other).value.status, 'succeeded');
  assert.equal(jobs.start({ ...other, data: { changed: true } }).code, 409);
});
test('cancellation is terminal only after the asynchronous writer settles', async () => {
  let release;
  const jobs = createJobs('boot', {
    upload: async (_data, signal) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      signal.throwIfAborted();
    },
  });
  const payload = { bootId: 'boot', operationId: 'upload', action: 'upload' };
  jobs.start(payload);
  await turn();
  assert.equal(jobs.cancel('upload').status, 'running');
  assert.equal(jobs.start({ ...payload, operationId: 'second' }).code, 409);
  release();
  await turn();
  assert.equal(jobs.get('upload').status, 'cancelled');
  assert.ok(jobs.get('upload').finishedAt);
});
test('no fixed hourly job count prevents a later preservation operation', async () => {
  const jobs = createJobs('boot', { capture: async () => ({}) });
  for (let index = 0; index < 140; index++) {
    assert.equal(
      jobs.start({
        bootId: 'boot',
        operationId: `job-${index}`,
        action: 'capture',
      }).code,
      202,
    );
    await turn();
  }
});
test('trust requires exact expected manager device/public key and exact scopes', () => {
  const key = randomBytes(32),
    identity = {
      publicKey: key.toString('base64url'),
      deviceId: createHash('sha256').update(key).digest('hex'),
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
    };
  process.env.EXPECTED_MANAGER_DEVICE_ID = identity.deviceId;
  process.env.EXPECTED_MANAGER_PUBLIC_KEY = identity.publicKey;
  assert.equal(validateIdentity(identity), identity);
  assert.throws(() =>
    validateIdentity({ ...identity, scopes: ['operator.admin'] }),
  );
  process.env.EXPECTED_MANAGER_DEVICE_ID = '0'.repeat(64);
  assert.throws(() => validateIdentity(identity));
});
test('configuration preserves policy and rejects escaping paths and automatic pairing', () => {
  const config = defaults();
  assert.doesNotThrow(() => auditConfig(config));
  assert.equal(config.agents.defaults.maxConcurrent, 10);
  assert.deepEqual(config.tools.allow, ['read', 'write', 'edit', 'web_fetch']);
  assert.throws(() =>
    auditConfig({
      ...config,
      agents: { defaults: { workspace: '/tmp/escape' } },
    }),
  );
  assert.throws(() =>
    auditConfig({
      ...config,
      agents: { defaults: { workspace: '/recovery/tmp/documents' } },
    }),
  );
  assert.throws(() =>
    auditConfig({
      ...config,
      agents: { defaults: { workspace: '/recovery/cache/workspace' } },
    }),
  );
  config.gateway.nodes.pairing.autoApproveLocal = true;
  assert.throws(() => auditConfig(config));
});
test('object/grant validation deduplicates user content, enforces exact R2 origin/object and has no old object cap', () => {
  const object = {
    size: 129 * 1024 * 1024,
    sha256: 'a'.repeat(64),
    md5: 'a'.repeat(22) + '==',
  };
  const descriptor = {
    version: 1,
    checkpointId: 'checkpoint',
    archive: { ...object, key: 'recovery/checkpoint/internal.tar.gz' },
    manifest: { ...object, key: 'recovery/checkpoint/manifest.json' },
    files: Array.from({ length: 65 }, () => ({
      ...object,
      key: 'files/' + object.sha256,
    })),
  };
  assert.equal(objects(descriptor).length, 3);
  process.env.R2_ORIGIN = 'https://account.r2.cloudflarestorage.com';
  const grant = {
    key: descriptor.archive.key,
    url: `${process.env.R2_ORIGIN}/bucket/${descriptor.archive.key}?X-Amz-Signature=private`,
  };
  assert.equal(grantsFor([grant], [descriptor.archive]).size, 1);
  assert.throws(() =>
    grantsFor(
      [{ ...grant, url: `https://evil.test/bucket/${grant.key}` }],
      [descriptor.archive],
    ),
  );
  assert.throws(() =>
    grantsFor(
      [{ ...grant, url: `${process.env.R2_ORIGIN}/bucket/other` }],
      [descriptor.archive],
    ),
  );
  assert.throws(() =>
    grantsFor(
      [{ ...grant, headers: { authorization: 'evil' } }],
      [descriptor.archive],
    ),
  );
});
