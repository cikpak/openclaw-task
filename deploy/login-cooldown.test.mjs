import { expect, it, vi } from 'vitest';
import { retryThrottledLogin } from '../scripts/login-cooldown.mjs';

it('does not delay or retry a successful login', async () => {
  const response = new Response('', { status: 200 });
  const attempt = vi.fn().mockResolvedValue(response);
  const sleep = vi.fn();
  expect(await retryThrottledLogin(attempt, { sleep })).toBe(response);
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it('honors the actual throttle header before retrying once', async () => {
  const success = new Response('', { status: 200 });
  const attempt = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    )
    .mockResolvedValueOnce(success);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const onWait = vi.fn();
  expect(await retryThrottledLogin(attempt, { sleep, onWait })).toBe(success);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(61_000);
  expect(attempt).toHaveBeenCalledTimes(2);
  expect(onWait).toHaveBeenCalledExactlyOnceWith(
    'Honouring login rate limit: wait 61s.',
  );
});

it.each([null, '999', 'garbage'])(
  'rejects unsafe Retry-After %s without retrying',
  async (value) => {
    const attempt = vi.fn().mockResolvedValue(
      new Response('', {
        status: 429,
        headers: value === null ? {} : { 'retry-after': value },
      }),
    );
    const sleep = vi.fn();
    await expect(retryThrottledLogin(attempt, { sleep })).rejects.toThrow();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  },
);

it('leaves a second throttle failure visible rather than looping or bypassing it', async () => {
  const response = new Response('', {
    status: 429,
    headers: { 'retry-after': '0' },
  });
  const attempt = vi.fn().mockResolvedValue(response);
  const sleep = vi.fn().mockResolvedValue(undefined);
  expect(await retryThrottledLogin(attempt, { sleep, onWait: vi.fn() })).toBe(
    response,
  );
  expect(attempt).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
});
