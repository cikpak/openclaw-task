import { afterEach, expect, it } from 'vitest';
import { lifecycleFixture } from './fixture.js';
const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = lifecycleFixture();
  fixtures.push(fixture);
  return fixture;
}

it.each(['capture', 'verify', 'commit'])(
  'a %s failure keeps local disk and postpones sleep retry',
  async (failure) => {
    const f = setup();
    await f.wake();
    f.time += 60_001;
    await f.core.tick();
    await f.until('capturing');
    if (failure === 'capture') f.captureFails = true;
    if (failure === 'verify') f.verifyFails = true;
    if (failure === 'commit') f.commitFails = true;
    for (let n = 0; n < 5 && f.core.status !== 'cancelling'; n++)
      await f.core.tick();
    expect(f.core.status).toBe('cancelling');
    expect(f.core.snapshot().checkpoint).toBeNull();
    expect(f.calls).not.toContain('destroy');
    f.captureFails = false;
    f.verifyFails = false;
    f.commitFails = false;
    const retryAt = f.core.snapshot().retryAt;
    await f.core.tick();
    expect(f.core.status).toBe('cancelling');
    f.time = retryAt;
    await f.until('ready');
    expect(f.calls).toContain('resume');
    expect(f.calls).not.toContain('restore');
    expect(f.calls).not.toContain('destroy');
  },
);

it('accepted work can resume locally during save backoff', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('capturing');
  f.captureFails = true;
  await f.core.tick();
  f.captureFails = false;
  f.pending = true;
  await f.core.requestWake();
  await f.until('ready');
  expect(f.calls).toContain('resume');
  expect(f.calls).not.toContain('restore');
});

it('recreation reattaches supervision and authenticates before reporting ready', async () => {
  const f = setup();
  await f.wake();
  const attaches = f.calls.filter((call) => call === 'attach').length;
  const connects = f.calls.filter((call) => call === 'connect').length;
  f.recreate();
  expect(f.core.ready).toBe(false);
  expect(f.core.deadline()).toBe(f.time + 1);
  await f.core.tick();
  expect(f.core.ready).toBe(true);
  expect(f.calls.filter((call) => call === 'attach').length).toBeGreaterThan(
    attaches,
  );
  expect(f.calls.filter((call) => call === 'connect')).toHaveLength(
    connects + 1,
  );
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
});

it('recreation polls a stable existing capture job and rejects stale boot results', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('capturing');
  f.held.add('capture');
  await f.core.tick();
  const job = f.core.snapshot().job;
  f.recreate();
  await f.core.tick();
  expect(f.core.snapshot().job).toEqual(job);
  const original = f.driver.helperStatus.bind(f.driver);
  f.driver.helperStatus = async (id) => ({
    ...(await original(id)),
    bootId: 'stale-boot',
  });
  await f.core.tick();
  expect(f.core.status).toBe('cancelling');
  expect(f.calls).not.toContain('commit');
  expect(f.calls).not.toContain('destroy');
});

it('lost disk before the first checkpoint fails closed instead of initializing defaults', async () => {
  const f = setup();
  await f.wake();
  f.loseDisk();
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().failure).toBe('missing-checkpoint');
  expect(f.core.deadline()).toBeNull();
  await f.core.requestWake();
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
  expect(f.calls.filter((call) => call === 'start')).toHaveLength(1);
  expect(f.core.ready).toBe(false);
});

it('lost disk after checkpoint restores and never silently reinitializes', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('asleep');
  await f.wake();
  const restores = f.calls.filter((call) => call === 'restore').length;
  f.loseDisk();
  await f.core.tick();
  await f.until('ready');
  expect(f.calls.filter((call) => call === 'restore')).toHaveLength(
    restores + 1,
  );
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
});

it('failed Gateway authentication retries the same local environment without restore', async () => {
  const f = setup();
  await f.wake();
  f.recreate();
  f.connectFails = true;
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  f.connectFails = false;
  f.time = f.core.snapshot().retryAt;
  await f.until('ready');
  expect(f.calls).not.toContain('restore');
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
});

it('restore failures leave Gateway stopped and the durable committed generation intact', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('asleep');
  await f.core.requestWake();
  await f.until('restoring');
  const connects = f.calls.filter((call) => call === 'connect').length;
  const original = f.driver.helperStatus.bind(f.driver);
  f.driver.helperStatus = async (id) => ({
    ...(await original(id)),
    state: 'failed',
  });
  await f.core.tick();
  expect(f.core.status).toBe('failed');
  expect(f.core.snapshot().checkpoint).toEqual(f.checkpoint);
  expect(f.calls.filter((call) => call === 'connect')).toHaveLength(connects);
});
