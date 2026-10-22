/* eslint-disable @typescript-eslint/require-await -- Async fake driver mirrors bounded production hooks. */
import { Store } from '../../../../backend/src/database.js';
import { DurableLifecycle } from './index.js';
import type {
  JobKind,
  JobStatus,
  LifecycleContext,
  LifecycleDriver,
  LifecycleJob,
  RecoveryCheckpoint,
} from './types.js';

export function lifecycleFixture() {
  const db = new Store(':memory:').db;
  const storage = {
    sql: {
      exec(query: string, ...values: unknown[]) {
        const statement = db.prepare(query);
        if (statement.reader) return statement.all(...values);
        statement.run(...values);
        return [];
      },
    },
    transactionSync<T>(operation: () => T): T {
      return db.transaction(operation)();
    },
  } as unknown as LifecycleContext['storage'];
  const calls: string[] = [];
  const checkpoint: RecoveryCheckpoint = {
    generation: 'generation-1',
    manifestKey: 'recovery/generation-1/manifest.json',
    manifestSha256: 'a'.repeat(64),
  };
  let time = 1_000;
  let running = false;
  let bootId = '';
  let busy = false;
  let pending = false;
  let captureFails = false;
  let verifyFails = false;
  let commitFails = false;
  let destroyFails = false;
  let connectFails = false;
  let beforeDestroy: (() => void) | undefined;
  const jobs = new Map<string, LifecycleJob>();
  const held = new Set<JobKind>();
  const schedule = {
    set: () => Promise.resolve(),
  };
  const driver: LifecycleDriver = {
    inspect: async () => ({ running, ...(running ? { bootId } : {}) }),
    attach: async () => {
      calls.push('attach');
    },
    start: async (id) => {
      calls.push('start');
      running = true;
      bootId = id;
    },
    helperStart: async (job) => {
      calls.push(job.kind);
      jobs.set(job.id, job);
    },
    helperStatus: async (id) => {
      const job = jobs.get(id)!;
      const state: JobStatus['state'] = held.has(job.kind)
        ? 'running'
        : captureFails && job.kind === 'capture'
          ? 'failed'
          : 'complete';
      return {
        id,
        attemptId: job.attemptId,
        bootId: job.bootId,
        state,
        ...(job.kind === 'capture' ? { checkpoint } : {}),
      };
    },
    helperCancel: async (job) => {
      calls.push('cancel');
      held.delete(job.kind);
      jobs.set(job.id, job);
    },
    prepare: async () => {
      calls.push('prepare');
      return { ready: !busy, expiresAt: time + 5_000 };
    },
    resume: async () => {
      calls.push('native-resume');
    },
    stopWriters: async () => {
      calls.push('stop-writers');
    },
    connect: async () => {
      calls.push('connect');
      if (connectFails) throw Error('connect failed');
    },
    disconnect: () => {
      calls.push('disconnect');
    },
    busy: async () => busy || pending,
    pending: () => pending,
    verifyCheckpoint: async () => {
      calls.push('verify');
      if (verifyFails) throw Error('bad object');
    },
    commit: () => {
      calls.push('commit');
      if (commitFails) throw Error('sql failure');
    },
    destroy: async () => {
      calls.push('destroy');
      beforeDestroy?.();
      if (destroyFails) throw Error('uncertain stop');
      running = false;
    },
  };
  const create = () =>
    new DurableLifecycle({ storage, schedule }, driver, { now: () => time });
  let core = create();
  return {
    driver,
    storage,
    calls,
    held,
    jobs,
    checkpoint,
    get core() {
      return core;
    },
    recreate() {
      core = create();
      return core;
    },
    set time(value: number) {
      time = value;
    },
    get time() {
      return time;
    },
    set busy(value: boolean) {
      busy = value;
    },
    set pending(value: boolean) {
      pending = value;
    },
    set captureFails(value: boolean) {
      captureFails = value;
    },
    set verifyFails(value: boolean) {
      verifyFails = value;
    },
    set commitFails(value: boolean) {
      commitFails = value;
    },
    set destroyFails(value: boolean) {
      destroyFails = value;
    },
    set connectFails(value: boolean) {
      connectFails = value;
    },
    set beforeDestroy(value: () => void) {
      beforeDestroy = value;
    },
    loseDisk() {
      running = false;
    },
    async until(phase: string, limit = 30) {
      for (let index = 0; core.status !== phase && index < limit; index++)
        await core.tick();
      if (core.status !== phase)
        throw Error(`Expected ${phase}, got ${core.status}`);
    },
    async wake() {
      await core.requestWake();
      await this.until('ready');
    },
    close() {
      db.close();
    },
  };
}
