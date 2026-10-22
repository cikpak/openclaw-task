import { afterEach, expect, it } from 'vitest';
import { lifecycleFixture } from './fixture.js';

const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = lifecycleFixture();
  fixtures.push(fixture);
  return fixture;
}
function barrier() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { release, held, entered, started };
}

it('persists an arrival while writer shutdown is unresolved and cancels before capture', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('stopping-writers');
  const stop = barrier();
  f.driver.stopWriters = async () => {
    stop.entered();
    await stop.held;
  };
  const tick = f.core.tick();
  await stop.started;
  f.pending = true;
  const wake = f.core.requestWake();
  expect(f.core.snapshot().wantWake).toBe(true);
  stop.release();
  await tick;
  await wake;
  await f.until('ready');
  expect(f.calls).not.toContain('capture');
  expect(f.calls).not.toContain('destroy');
  expect(f.calls).not.toContain('restore');
  expect(f.calls).toContain('resume');
});

it('settles capture cancellation before restarting local writers after an in-flight result', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('capturing');
  const capture = barrier();
  const original = f.driver.helperStatus.bind(f.driver);
  let captured = false;
  f.driver.helperStatus = async (id) => {
    if (!captured) {
      captured = true;
      capture.entered();
      await capture.held;
    }
    return original(id);
  };
  const tick = f.core.tick();
  await capture.started;
  f.pending = true;
  const wake = f.core.requestWake();
  capture.release();
  await tick;
  await wake;
  await f.until('ready');
  expect(f.calls).not.toContain('commit');
  expect(f.calls).not.toContain('destroy');
  expect(f.calls).not.toContain('restore');
});

it('does not commit a verified candidate if work arrives while object verification is pending', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('verifying');
  const verify = barrier();
  f.driver.verifyCheckpoint = async () => {
    verify.entered();
    await verify.held;
  };
  const tick = f.core.tick();
  await verify.started;
  f.pending = true;
  const wake = f.core.requestWake();
  verify.release();
  await tick;
  await wake;
  await f.until('ready');
  expect(f.core.snapshot().checkpoint).toBeNull();
  expect(f.calls).not.toContain('commit');
  expect(f.calls).not.toContain('destroy');
  expect(f.calls).not.toContain('restore');
});

it('transient helper health failure does not replace the current local disk with a checkpoint', async () => {
  const f = setup();
  await f.wake();
  const inspect = f.driver.inspect.bind(f.driver);
  f.driver.inspect = () =>
    Promise.reject(new Error('Helper health response lost'));
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().failure).toBe('wake');
  f.driver.inspect = inspect;
  f.time = f.core.snapshot().retryAt;
  await f.until('ready');
  expect(f.calls.filter((call) => call === 'start')).toHaveLength(1);
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
  expect(f.calls).not.toContain('restore');
});

it('reconstruction of an uncertain stop must reconcile destruction before any reconnect', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('committing');
  f.destroyFails = true;
  await f.core.tick();
  expect(f.core.status).toBe('stop-issued');
  const connects = f.calls.filter((call) => call === 'connect').length;
  f.recreate();
  f.pending = true;
  await f.core.requestWake();
  expect(f.calls.filter((call) => call === 'connect')).toHaveLength(connects);
  f.destroyFails = false;
  await f.until('ready');
  expect(f.calls).toContain('restore');
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
});

it('uses a fresh resume operation after a terminal failed helper restart', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('preparing');
  await f.core.requestWake();
  await f.until('recovering');
  const failedResume = f.core.snapshot().job!.id;
  const status = f.driver.helperStatus.bind(f.driver);
  f.driver.helperStatus = async (id) => {
    const result = await status(id);
    return id === failedResume ? { ...result, state: 'failed' } : result;
  };
  await f.core.tick();
  expect(f.core.status).toBe('cancelling');
  f.time = f.core.snapshot().retryAt;
  await f.until('ready');
  const resumes = [...f.jobs.values()].filter((job) => job.kind === 'resume');
  expect(new Set(resumes.map((job) => job.id)).size).toBeGreaterThan(1);
  expect(f.calls).not.toContain('restore');
  expect(f.calls).not.toContain('destroy');
});
