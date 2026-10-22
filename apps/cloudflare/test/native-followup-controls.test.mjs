import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helperFailure } from './native-followup-errors.mjs';
import { helperJobs } from './native-followup-jobs.mjs';
import { bootstrapReady } from './native-followup-readiness.mjs';

test('retains only allowlisted helper conflict categories', async () => {
  for (const [message, category] of [
    ['Another operation is active', 'active-operation'],
    ['Operation conflict', 'operation-conflict'],
    ['Stale boot', 'stale-boot'],
    ['sensitive-unexpected-body', 'unknown-conflict'],
  ]) {
    const error = await helperFailure(
      new Response(JSON.stringify({ error: message }), { status: 409 }),
    );
    assert.equal(error.helperStatus, 409);
    assert.equal(error.helperCategory, category);
    assert.equal(error.message.includes(message), false);
    assert.equal(JSON.stringify(error).includes('sensitive'), false);
  }
});

test('tracks exact owned job completion without replaying mutations', async () => {
  const requests = [];
  let id,
    reads = 0,
    boot = 'test-boot';
  const jobs = helperJobs(
    async (path, body) => {
      requests.push({ path, body });
      if (body) {
        id = body.operationId;
        return { operationId: id, action: body.action, status: 'running' };
      }
      assert.equal(path, `/jobs/${id}`);
      reads++;
      return {
        operationId: id,
        action: 'pair',
        status: 'succeeded',
        result: { paired: true },
        ...(reads > 1 ? { finishedAt: 123 } : {}),
      };
    },
    () => boot,
  );
  assert.deepEqual(await jobs.job('pair', {}), { paired: true });
  assert.deepEqual(await jobs.status(), [
    { action: 'pair', status: 'succeeded', finishedAtPresent: true },
  ]);
  assert.equal(requests.filter((request) => request.body).length, 1);
  boot = 'fresh-boot';
  assert.deepEqual(await jobs.status(), []);
});

test('SDK hello cannot finish fixture readiness before owned pairing and terminal timestamp', async () => {
  let release;
  const paired = new Promise((resolve) => {
    release = resolve;
  });
  let completed = false,
    reads = 0;
  const ready = bootstrapReady(
    { waitReady: async () => {} },
    {
      jobStatus: async () => [
        {
          action: 'pair',
          status: reads++ ? 'succeeded' : 'running',
          finishedAtPresent: reads >= 3,
        },
      ],
    },
    () => paired,
    () => ({ pending: completed ? 0 : 1, completed: completed ? 1 : 0 }),
  ).then((value) => {
    completed = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(reads, 1);
  release();
  const result = await ready;
  assert.equal(reads, 3);
  assert.equal(result.atSdkReady.pairing.pending, 1);
  assert.equal(result.afterOwnedCompletion.jobs[0].finishedAtPresent, true);
});

test('rechecks a new owned pairing callback after final transport readiness', async () => {
  let current = Promise.resolve(),
    release,
    waits = 0,
    completed = false;
  const ready = bootstrapReady(
    {
      waitReady: async () => {
        if (++waits === 2)
          current = new Promise((resolve) => {
            release = resolve;
          });
      },
    },
    {
      jobStatus: async () => [
        { action: 'pair', status: 'succeeded', finishedAtPresent: true },
      ],
    },
    () => current,
    () => ({ pending: 0, completed: 1 }),
  ).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(waits, 2);
  release();
  await ready;
  assert.equal(waits, 3);
});
