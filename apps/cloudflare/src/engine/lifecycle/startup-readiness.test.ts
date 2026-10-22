import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleFixture } from './fixture.js';

const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = lifecycleFixture();
  fixtures.push(fixture);
  return fixture;
}
function delayedHelper(f: ReturnType<typeof setup>) {
  const inspect = f.driver.inspect.bind(f.driver);
  let available = false;
  f.driver.inspect = async () => {
    const state = await inspect();
    if (state.running && !available)
      throw new Error('Helper listener not accepting requests');
    return state;
  };
  return () => {
    available = true;
  };
}

it('polls a newly started helper promptly without reinitializing or declaring wake failure', async () => {
  const f = setup();
  const ready = delayedHelper(f);
  const failure = vi.fn();
  f.driver.onFailure = failure;
  await f.core.requestWake();
  await f.core.tick();
  const started = f.core.snapshot();
  expect(started.phase).toBe('waking');
  expect(started.initialized).toBe(false);
  expect(started.helperReadyDeadline).toBe(f.time + 60_000);
  expect(f.core.deadline()).toBe(f.time + 1000);
  expect(failure).not.toHaveBeenCalled();
  expect(f.calls).not.toContain('initialize');
  f.time += 1000;
  ready();
  await f.until('ready');
  expect(f.core.snapshot().bootId).toBe(started.bootId);
  expect(f.core.snapshot().attemptId).toBe(started.attemptId);
  expect(f.core.snapshot().helperReadyDeadline).toBeUndefined();
  expect(f.calls.filter((call) => call === 'start')).toHaveLength(1);
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
  expect(f.calls).not.toContain('restore');
  expect(f.calls).not.toContain('destroy');
});

it('retains the fixed helper deadline and boot identity after manager recreation', async () => {
  const f = setup();
  const ready = delayedHelper(f);
  await f.core.requestWake();
  await f.core.tick();
  const started = f.core.snapshot();
  f.time += 20_000;
  f.recreate();
  await f.core.tick();
  expect(f.core.snapshot().helperReadyDeadline).toBe(
    started.helperReadyDeadline,
  );
  expect(f.core.snapshot().failure).toBeNull();
  expect(f.core.deadline()).toBe(f.time + 1000);
  expect(f.calls.filter((call) => call === 'start')).toHaveLength(1);
  ready();
  await f.until('ready');
  expect(f.core.snapshot().bootId).toBe(started.bootId);
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
});

it('bounds startup polling and retains ordinary failure backoff after its deadline', async () => {
  const f = setup();
  delayedHelper(f);
  const failure = vi.fn();
  f.driver.onFailure = failure;
  await f.core.requestWake();
  await f.core.tick();
  const deadline = f.core.snapshot().helperReadyDeadline!;
  f.time = deadline - 500;
  await f.core.tick();
  expect(f.core.deadline()).toBe(deadline);
  f.time = deadline;
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().failure).toBe('wake');
  expect(f.core.deadline()).toBe(f.time + 30_000);
  expect(failure).toHaveBeenCalledTimes(1);
  f.time += 30_000;
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().helperReadyDeadline).toBeUndefined();
  expect(f.calls.filter((call) => call === 'start')).toHaveLength(1);
  expect(f.calls).not.toContain('initialize');
  expect(f.calls).not.toContain('destroy');
});

it('keeps one fixed startup window across immediate exits and backs off before restarting', async () => {
  const f = setup();
  const start = vi.fn(() => Promise.resolve());
  f.driver.start = start;
  await f.core.requestWake();
  await f.core.tick();
  const deadline = f.core.snapshot().helperReadyDeadline!;
  expect(start).toHaveBeenCalledTimes(1);
  f.time += 30_000;
  await f.core.tick();
  expect(start).toHaveBeenCalledTimes(2);
  expect(f.core.snapshot().helperReadyDeadline).toBe(deadline);
  f.time = deadline;
  await f.core.tick();
  expect(start).toHaveBeenCalledTimes(2);
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().helperReadyDeadline).toBeUndefined();
  expect(f.core.deadline()).toBe(f.time + 30_000);
  f.time += 30_000;
  await f.core.tick();
  expect(start).toHaveBeenCalledTimes(3);
  expect(f.core.snapshot().helperReadyDeadline).toBe(f.time + 60_000);
  expect(f.calls).not.toContain('initialize');
  expect(f.calls).not.toContain('restore');
  expect(f.calls).not.toContain('destroy');
});

it('does not grant startup grace to platform start failures or a running established engine', async () => {
  const f = setup();
  f.driver.start = () => Promise.reject(new Error('Platform start failed'));
  await f.core.requestWake();
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().helperReadyDeadline).toBeUndefined();
  expect(f.core.deadline()).toBe(f.time + 30_000);
  const established = setup();
  await established.wake();
  established.driver.inspect = () => Promise.reject(new Error('Helper lost'));
  await established.core.tick();
  expect(established.core.status).toBe('failed');
  expect(established.core.snapshot().helperReadyDeadline).toBeUndefined();
  expect(established.core.deadline()).toBe(established.time + 30_000);
  expect(established.calls).not.toContain('restore');
  expect(established.calls).not.toContain('destroy');
});
