import { afterEach, expect, it } from 'vitest';
import { lifecycleFixture } from './fixture.js';
const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = lifecycleFixture();
  fixtures.push(fixture);
  return fixture;
}

it('preserves and verifies a coherent checkpoint before destruction, then restores the same generation', async () => {
  const f = setup();
  await f.wake();
  expect(f.core.ready).toBe(true);
  f.time += 60_001;
  await f.core.tick();
  await f.until('asleep');
  expect(f.core.snapshot().checkpoint).toEqual(f.checkpoint);
  const positions = [
    'prepare',
    'stop-writers',
    'capture',
    'verify',
    'commit',
    'destroy',
  ].map((call) => f.calls.indexOf(call));
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  await f.wake();
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
  expect(f.calls).toContain('restore');
  const restore = [...f.jobs.values()].find((job) => job.kind === 'restore');
  expect(restore?.checkpoint).toEqual(f.checkpoint);
});

it('uses native preparation repeatedly to renew protection while native work drains', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  f.busy = true;
  await f.core.tick();
  await f.core.tick();
  expect(f.calls.filter((call) => call === 'prepare')).toHaveLength(2);
  expect(f.calls).not.toContain('stop-writers');
});

it('does not sleep for queued or uncertain work and excludes passive browser state', async () => {
  const f = setup();
  await f.wake();
  f.busy = true;
  f.time += 90_000;
  await f.core.tick();
  expect(f.core.status).toBe('ready');
  f.busy = false;
  f.time += 59_999;
  await f.core.tick();
  expect(f.core.status).toBe('ready');
  f.time += 1;
  await f.core.tick();
  expect(f.core.status).toBe('preparing');
});

it.each([
  'preparing',
  'stopping-writers',
  'capturing',
  'verifying',
  'committing',
])('cancels during %s and resumes existing local files', async (phase) => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until(phase);
  await f.core.requestWake();
  await f.until('ready');
  expect(f.calls).not.toContain('destroy');
  expect(f.calls).not.toContain('restore');
  expect(f.calls).toContain('resume');
});

it('new work after final stop issuance reconciles shutdown before clean wake', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('committing');
  let wake: Promise<void> | undefined;
  f.beforeDestroy = () => {
    expect(f.core.status).toBe('stop-issued');
    wake = f.core.requestWake();
  };
  await f.core.tick();
  await wake;
  await f.until('ready');
  expect(f.calls.indexOf('destroy')).toBeLessThan(f.calls.indexOf('restore'));
});

it('uncertain destruction remains fenced and cannot reconnect to live data', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('committing');
  f.destroyFails = true;
  await f.core.tick();
  const connects = f.calls.filter((call) => call === 'connect').length;
  expect(f.core.status).toBe('stop-issued');
  await f.core.requestWake();
  expect(f.core.status).toBe('stop-issued');
  expect(f.calls.filter((call) => call === 'connect')).toHaveLength(connects);
  f.destroyFails = false;
  await f.until('ready');
  expect(f.calls).toContain('restore');
});

it('checks synchronous durable pending work immediately before the stop fence', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('committing');
  f.driver.commit = () => {
    f.pending = true;
  };
  await f.core.tick();
  expect(f.core.status).toBe('cancelling');
  expect(f.core.snapshot().checkpoint).toEqual(f.checkpoint);
  expect(f.calls).not.toContain('destroy');
});
