import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  healthFailure,
  observeHealth,
} from '../../apps/cloudflare/test/acceptance-health.ts';
test('health failures expose fixed categories, never original errors or cause values', () => {
  for (const [error, expected] of [
    [
      Error('private value', { cause: { code: 'ECONNREFUSED' } }),
      'connection-refused',
    ],
    [
      Error('connect(): Connection refused private address'),
      'connection-refused',
    ],
    [new DOMException('private value', 'TimeoutError'), 'timeout'],
    [new DOMException('private value', 'AbortError'), 'timeout'],
    [Error('Private engine helper unavailable'), 'http-rejected'],
    [TypeError('private value'), 'type-error'],
    [Error('private value'), 'other'],
    [{ message: 'private value' }, 'non-error'],
  ])
    assert.equal(healthFailure(error), expected);
});
test('failed diagnostic persistence cannot replace the original health outcome', () => {
  assert.doesNotThrow(() =>
    observeHealth(
      {
        sql: {
          exec() {
            throw Error('storage unavailable');
          },
        },
      },
      'attempt',
    ),
  );
});
