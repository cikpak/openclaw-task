import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

/** Acceptance logins share the real throttle; retry once after its bounded cooldown. */
export async function retryThrottledLogin(
  attempt,
  { sleep = delay, onWait = console.info } = {},
) {
  const response = await attempt();
  if (response.status !== 429) return response;
  const retryAfter = response.headers.get('retry-after');
  assert.match(retryAfter ?? '', /^\d+$/u, 'Login cooldown must be numeric');
  const cooldown = (Number(retryAfter) + 1) * 1000;
  assert.ok(cooldown <= 61_000, 'Login cooldown must be at most 61 seconds');
  onWait(`Honouring login rate limit: wait ${cooldown / 1000}s.`);
  await sleep(cooldown);
  return attempt();
}
