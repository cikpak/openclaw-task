import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { until } from './native-followup-fixture.mjs';

export function helperJobs(request, bootId) {
  const owned = new Map();
  const actions = new Set([
    'initialize',
    'start',
    'stop',
    'pair',
    'full-message',
    'inspect',
    'capture',
    'upload',
    'restore',
  ]);
  const statuses = new Set(['running', 'succeeded', 'failed', 'cancelled']);
  let generation = bootId();
  const remember = (result) => {
    owned.set(result.operationId, {
      action: actions.has(result.action) ? result.action : 'unknown',
      status: statuses.has(result.status) ? result.status : 'unknown',
      finishedAtPresent: Number.isFinite(result.finishedAt),
    });
    return result;
  };
  return {
    job: async (action, data = {}) => {
      if (generation !== bootId()) {
        owned.clear();
        generation = bootId();
      }
      let result = remember(
        await request('/jobs', {
          action,
          data,
          operationId: randomUUID(),
          bootId: bootId(),
        }),
      );
      await until(
        async () => {
          if (result.status !== 'running') return true;
          result = remember(await request(`/jobs/${result.operationId}`));
          return result.status !== 'running';
        },
        action,
        360_000,
      );
      assert.equal(result.status, 'succeeded', `${action}: ${result.status}`);
      return result.result;
    },
    status: async () => {
      if (generation !== bootId()) {
        owned.clear();
        generation = bootId();
      }
      for (const [id, value] of owned)
        if (!value.finishedAtPresent) remember(await request(`/jobs/${id}`));
      return [...owned.values()].slice(-16).map((value) => ({ ...value }));
    },
  };
}
