import { afterEach, expect, it, vi } from 'vitest';
import { EngineDriver } from './driver.js';

afterEach(() => vi.useRealTimers());

it('releases native suspension even while application dispatch is intentionally gated', async () => {
  const request = vi.fn(() => Promise.resolve({}));
  const get = vi.fn(() => Promise.resolve('native-suspension'));
  const receiver = {
    context: { state: { storage: { get } } },
    gateway: { ready: false, request },
  };
  await EngineDriver.prototype.resume.call(
    receiver as unknown as EngineDriver,
    'attempt',
  );
  expect(request).toHaveBeenCalledExactlyOnceWith('gateway.suspend.resume', {
    suspensionId: 'native-suspension',
  });
});

it('keeps native busy preparation on a finite retry deadline without inventing a suspension identity', async () => {
  const put = vi.fn(() => Promise.resolve());
  const receiver = {
    context: { state: { storage: { put } } },
    gateway: {
      request: () =>
        Promise.resolve({
          status: 'busy',
          reason: 'gateway-draining',
          retryAfterMs: 20_000,
        }),
    },
  };
  const before = Date.now();
  const result = await EngineDriver.prototype.prepare.call(
    receiver as unknown as EngineDriver,
    'attempt',
  );
  expect(result.ready).toBe(false);
  expect(Number.isFinite(result.expiresAt)).toBe(true);
  expect(result.expiresAt).toBeGreaterThan(before);
  expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 20_000);
  expect(put).not.toHaveBeenCalled();
});

it('refreshes container supervision outside a pending verification step and stops refreshing after settlement', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const attach = vi.fn(() => Promise.resolve());
  const waitUntil = vi.fn((work: Promise<unknown>) => {
    void work;
  });
  const verify = vi.fn(
    (checkpoint: unknown, options: { signal: AbortSignal }) => {
      void checkpoint;
      void options;
      return pending;
    },
  );
  const receiver = {
    context: { state: { waitUntil } },
    control: { attach },
    objects: { verify },
    pending: () => false,
    cancellationRequested: () => false,
  };
  const work = EngineDriver.prototype.verifyCheckpoint.call(
    receiver as unknown as EngineDriver,
    {
      generation: 'generation',
      manifestKey: 'manifest',
      manifestSha256: 'a'.repeat(64),
    },
  );
  await vi.advanceTimersByTimeAsync(40_001);
  expect(attach).toHaveBeenCalledTimes(2);
  expect(waitUntil).toHaveBeenCalledTimes(2);
  const options = verify.mock.calls[0]![1];
  expect(options.signal.aborted).toBe(false);
  finish();
  await work;
  await vi.advanceTimersByTimeAsync(40_000);
  expect(attach).toHaveBeenCalledTimes(2);
});
