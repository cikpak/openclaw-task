import { createHash } from 'node:crypto';
export const validId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export function createJobs(bootId, actions) {
  const jobs = new Map();
  return {
    get: (id) => jobs.get(id)?.public,
    cancel(id) {
      let job = jobs.get(id);
      if (!job) {
        job = {
          signature: null,
          public: {
            bootId,
            operationId: id,
            status: 'cancelled',
            cancelRequested: true,
            createdAt: Date.now(),
            finishedAt: Date.now(),
          },
        };
        jobs.set(id, job);
      }
      if (!job.public.finishedAt) {
        job.public.cancelRequested = true;
        job.controller.abort();
      }
      return job.public;
    },
    start(payload) {
      if (
        !validId(payload.operationId) ||
        payload.bootId !== bootId ||
        !Object.hasOwn(actions, payload.action)
      )
        return { code: 400, value: { error: 'Invalid operation or boot' } };
      if (
        Object.keys(payload).some(
          (key) => !['operationId', 'bootId', 'action', 'data'].includes(key),
        )
      )
        return { code: 400, value: { error: 'Unknown field' } };
      if (
        payload.data !== undefined &&
        (!payload.data ||
          typeof payload.data !== 'object' ||
          Array.isArray(payload.data))
      )
        return { code: 400, value: { error: 'Invalid operation data' } };
      const signature = createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
      const existing = jobs.get(payload.operationId);
      if (existing)
        return {
          code:
            existing.signature === null || existing.signature === signature
              ? 202
              : 409,
          value:
            existing.signature === null || existing.signature === signature
              ? existing.public
              : { error: 'Operation conflict' },
        };
      for (const [id, job] of jobs)
        if (
          job.public.finishedAt &&
          Date.now() - job.public.finishedAt > 3600000
        )
          jobs.delete(id);
      if ([...jobs.values()].some((job) => !job.public.finishedAt))
        return { code: 409, value: { error: 'Another operation is active' } };
      const job = {
        signature,
        controller: new AbortController(),
        public: {
          bootId,
          operationId: payload.operationId,
          action: payload.action,
          status: 'running',
          createdAt: Date.now(),
        },
      };
      jobs.set(payload.operationId, job);
      void Promise.resolve()
        .then(() =>
          actions[payload.action](payload.data ?? {}, job.controller.signal),
        )
        .then(
          (result) =>
            Object.assign(job.public, { status: 'succeeded', result }),
          () =>
            Object.assign(job.public, {
              status: job.controller.signal.aborted ? 'cancelled' : 'failed',
              error: 'Helper operation failed',
            }),
        )
        .finally(() => {
          job.public.finishedAt = Date.now();
        });
      return { code: 202, value: job.public };
    },
    async settle() {
      while ([...jobs.values()].some((job) => !job.public.finishedAt))
        await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}
