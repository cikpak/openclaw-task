import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runtime, origin } from './runtime.mjs';

test('real D1 login throttle preserves five attempts and advertises the remaining window', async () => {
  const app = await runtime();
  const address = '198.51.100.90';
  const key = createHash('sha256').update(`login:${address}`).digest('hex');
  const attempt = () =>
    app.public('/api/session', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'CF-Connecting-IP': address,
      },
      body: JSON.stringify({ username: 'owner', password: 'wrong-password' }),
    });
  try {
    for (let count = 0; count < 5; count++) {
      const response = await attempt();
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('retry-after'), null);
    }
    await app.db
      .prepare(
        'UPDATE login_rate_limits SET window_start = ? WHERE key_hash = ?',
      )
      .bind(Date.now() - 45_000, key)
      .run();
    const denied = await attempt();
    assert.equal(denied.status, 429);
    assert.equal((await denied.json()).code, 'RATE_LIMITED');
    const remaining = Number(denied.headers.get('retry-after'));
    assert.ok(
      remaining >= 14 && remaining <= 15,
      'Cooldown is remaining time, not another full minute',
    );
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    const repeated = await attempt();
    assert.equal(repeated.status, 429);
    assert.ok(Number(repeated.headers.get('retry-after')) <= remaining);
    await app.db
      .prepare(
        'UPDATE login_rate_limits SET window_start = ? WHERE key_hash = ?',
      )
      .bind(Date.now() - 60_001, key)
      .run();
    assert.equal(
      (await attempt()).status,
      401,
      'The expired window permits verification again',
    );
    const row = await app.db
      .prepare('SELECT attempts FROM login_rate_limits WHERE key_hash = ?')
      .bind(key)
      .first();
    assert.equal(row.attempts, 1);
  } finally {
    await app.mf.dispose();
  }
});
