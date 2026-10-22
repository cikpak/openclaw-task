import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForNativeWriters } from '../../test/acceptance/container/gateway-writer-wait.mjs';
const writer = () => Error('Detached engine writer remains');
test('read-only wait accepts only eventual authoritative verification, without a process census or signal', async () => {
  let time = 0,
    checks = 0;
  const result = await waitForNativeWriters({
    deadline: 100,
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
    verify: async () => {
      if (++checks < 3) throw writer();
    },
    snapshot: () => assert.fail('Waiting grants no census or target authority'),
    kill: () => assert.fail('Waiting must not signal any process'),
  });
  assert.deepEqual(result, { writerWaitMs: 50 });
  assert.equal(checks, 3);
});
test('FD, permission and unknown failures reject immediately without waiting', async () => {
  for (const message of [
    'Recovery writer descriptor remains',
    'Cannot verify process ownership',
    'Cannot verify recovery descriptor',
    'Detached engine writer remains extra',
    'private unexpected failure',
  ]) {
    const error = Error(message);
    let pauses = 0;
    await assert.rejects(
      waitForNativeWriters({
        deadline: 100,
        now: () => 0,
        verify: async () => {
          throw error;
        },
        delay: async () => {
          pauses++;
        },
      }),
      (actual) => actual === error,
    );
    assert.equal(pauses, 0);
  }
});
test('any persistent writer still fails closed at the original deadline', async () => {
  let time = 0,
    checks = 0;
  const error = writer();
  await assert.rejects(
    waitForNativeWriters({
      deadline: 30,
      now: () => time,
      verify: async () => {
        checks++;
        throw error;
      },
      delay: async (ms) => {
        time += ms;
      },
    }),
    (actual) => actual === error,
  );
  assert.equal(time, 30);
  assert.equal(checks, 2);
});
test('late success cannot pass the deadline and retains the original writer rejection', async () => {
  let time = 0,
    checks = 0;
  const error = writer();
  await assert.rejects(
    waitForNativeWriters({
      deadline: 100,
      now: () => time,
      verify: async () => {
        if (++checks === 1) throw error;
        time = 101;
      },
      delay: async (ms) => {
        time += ms;
      },
    }),
    (actual) => actual === error,
  );
  await assert.rejects(
    waitForNativeWriters({
      deadline: 100,
      now: () => time,
      verify: async () =>
        assert.fail('Expired budget cannot start another check'),
    }),
    /deadline exceeded/u,
  );
});
test('cancellation before verification or during pause prevents another check', async () => {
  for (const initiallyAborted of [true, false]) {
    const controller = new AbortController();
    let checks = 0;
    if (initiallyAborted) controller.abort();
    await assert.rejects(
      waitForNativeWriters({
        deadline: 100,
        now: () => 0,
        signal: controller.signal,
        verify: async () => {
          checks++;
          throw writer();
        },
        delay: (ms, value, options) => {
          controller.abort();
          return delay(ms, value, options);
        },
      }),
      { name: 'AbortError' },
    );
    assert.equal(checks, initiallyAborted ? 0 : 1);
  }
});
