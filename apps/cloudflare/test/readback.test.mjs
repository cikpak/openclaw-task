import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { verifyRemote } from '../container/readback.mjs';
import { createJobs } from '../container/jobs.mjs';
const bytes = Buffer.from('verified contents');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const object = (key) => ({
  key,
  size: bytes.length,
  sha256,
  md5: createHash('md5').update(bytes).digest('base64'),
});
const descriptor = {
  version: 1,
  checkpointId: 'readback',
  archive: object('recovery/readback/internal.tar.gz'),
  manifest: object('recovery/readback/manifest.json'),
  files: [object(`files/readback/${sha256}`)],
};
const all = [descriptor.archive, descriptor.manifest, ...descriptor.files];
const origin = 'https://abc123.r2.cloudflarestorage.com';
const grants = all.map(({ key }) => ({
  key,
  url: `${origin}/recovery/${key}?signed=true`,
}));
const signal = () => new AbortController().signal;

test('helper directly hashes every referenced object, including reused objects, into bounded exact receipt', async () => {
  const original = globalThis.fetch,
    previous = process.env.R2_ORIGIN;
  process.env.R2_ORIGIN = origin;
  try {
    const gets = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      gets.push(url);
      return new Response(bytes);
    };
    const receipt = await verifyRemote(descriptor, grants, signal());
    assert.equal(gets.length, 3);
    assert.equal(receipt.count, 3);
    assert.equal(receipt.checkpointId, 'readback');
    const tuples = all
      .map(({ key, size, sha256 }) => [key, size, sha256])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    assert.equal(
      receipt.objectsSha256,
      createHash('sha256').update(JSON.stringify(tuples)).digest('hex'),
    );
    assert.ok(JSON.stringify(receipt).length < 200);
    for (const body of [
      Buffer.alloc(bytes.length, 0),
      bytes.subarray(1),
      Buffer.concat([bytes, bytes]),
    ]) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(
        () => verifyRemote(descriptor, grants, signal()),
        /mismatch/,
      );
    }
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(
      () => verifyRemote(descriptor, grants, signal()),
      /unavailable/,
    );
    await assert.rejects(
      () => verifyRemote(descriptor, grants.slice(1), signal()),
      /grant count/,
    );
    await assert.rejects(
      () =>
        verifyRemote(descriptor, [grants[0], grants[0], grants[2]], signal()),
      /transfer grant/,
    );
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.R2_ORIGIN;
    else process.env.R2_ORIGIN = previous;
  }
});

test('cancellation interrupts streamed readback and cannot report successful helper completion', async () => {
  const original = globalThis.fetch,
    previous = process.env.R2_ORIGIN;
  process.env.R2_ORIGIN = origin;
  try {
    let release;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, 2));
            release = () => controller.enqueue(bytes.subarray(2));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const jobs = createJobs('boot', {
      upload: (_data, signal) => verifyRemote(descriptor, grants, signal),
    });
    const payload = {
      operationId: 'upload-readback',
      bootId: 'boot',
      action: 'upload',
    };
    assert.equal(jobs.start(payload).code, 202);
    await new Promise((resolve) => setImmediate(resolve));
    jobs.cancel(payload.operationId);
    release();
    await jobs.settle();
    assert.equal(jobs.get(payload.operationId).status, 'cancelled');
    assert.equal(cancelled, true);
    assert.equal(jobs.start({ ...payload, bootId: 'old' }).code, 400);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.R2_ORIGIN;
    else process.env.R2_ORIGIN = previous;
  }
});
