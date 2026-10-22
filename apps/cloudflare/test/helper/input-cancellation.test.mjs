import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, sources } from './input-cancellation-fixture.mjs';
import {
  beginInputCancellationProof,
  retireInputCancellationPrelude,
  trackInputCancellationPrelude,
} from '../../container/native-owner/input-cancellation.mjs';

test('actual native controller registration/cancellation branch emits scoped prelude proof only after synchronous commit', () => {
  const f = fixture();
  const result = f.cancel();
  assert.deepEqual(Array.from(result.runIds), ['input']);
  assert.deepEqual(Array.from(result.preExecutionInputCancellations), [
    {
      kind: 'pre-execution-input-cancelled',
      inputId: 'input',
      sessionId: 'native-session',
      sessionKey: 'agent:main:main',
      agentId: 'main',
    },
  ]);
  assert.equal(f.entry.controller.signal.aborted, true);
  assert.equal(f.context.chatAbortControllers.has('input'), false);
  assert.equal(f.registered.markExecutionStarted(), false);
});

for (const phase of [
  'deferred-single',
  'adopted-generated',
  'collect-owner',
  'summary-source',
  'retry-source',
])
  test(`original native lifecycle retires proof permanently for ${phase}`, async () => {
    const f = fixture();
    if (phase === 'adopted-generated') await f.adoption.lifecycle.onAdopted();
    else f.adoption.lifecycle.onDeferred();
    f.context.chatQueuedTurns.delete('input');
    trackInputCancellationPrelude(f.entry, 'input', 'followup', {
      id: 'gateway-client',
      mode: 'cli',
      displayName: 'Messenger manager',
    });
    const result = f.cancel();
    assert.deepEqual(Array.from(result.runIds), ['input']);
    assert.equal(result.preExecutionInputCancellations, undefined);
  });

for (const mode of ['steer', 'interrupt', undefined])
  test(`native mode ${mode} never qualifies`, () => {
    const f = fixture({ mode: mode ?? 'default-mode' });
    assert.equal(f.cancel().preExecutionInputCancellations, undefined);
  });
for (const client of [
  undefined,
  {},
  { id: 'gateway-client', mode: 'cli', displayName: 'Other client' },
])
  test(`unmanaged native identity ${JSON.stringify(client)} remains ordinary cancellation`, () => {
    const f = fixture({ client: client ?? {} });
    const result = f.cancel();
    assert.deepEqual(Array.from(result.runIds), ['input']);
    assert.equal(result.preExecutionInputCancellations, undefined);
  });

test('execution started native controller never qualifies', () => {
  const f = fixture();
  assert.equal(f.registered.markExecutionStarted(), true);
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
test('cancel-time onAdopted retirement prevents proof', () => {
  const f = fixture();
  f.setLifecycle(() => {
    void f.adoption.lifecycle.onAdopted().catch(() => {});
  });
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
test('replacement registration during native abort cannot inherit old proof', () => {
  const f = fixture();
  f.setLifecycle(() => {
    f.context.chatAbortControllers.set('input', {
      controller: new AbortController(),
    });
  });
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
test('native scope mutation during abort fails closed', () => {
  const f = fixture();
  f.setLifecycle(() => {
    f.entry.sessionId = 'replacement';
  });
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
test('preregistered dedupe cancellation remains generic without prelude proof', () => {
  const f = fixture();
  f.pendingOnly();
  const result = f.cancel();
  assert.deepEqual(Array.from(result.runIds), ['input']);
  assert.equal(result.preExecutionInputCancellations, undefined);
});
test('uncommitted abort cannot mint proof', () => {
  const f = fixture();
  const finish = beginInputCancellationProof(f.context, 'input', f.entry);
  assert.equal(finish(), undefined);
});
test('nonabortable controller produces no cancellation proof', () => {
  const f = fixture();
  f.entry.isAbortable = () => false;
  const result = f.cancel();
  assert.deepEqual(Array.from(result.runIds), []);
  assert.equal(result.preExecutionInputCancellations, undefined);
});
test('retirement before registration cannot be rearmed', () => {
  const f = fixture();
  retireInputCancellationPrelude(f.entry);
  trackInputCancellationPrelude(f.entry, 'input', 'followup', {
    id: 'gateway-client',
    mode: 'cli',
    displayName: 'Messenger manager',
  });
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
test('response patch adds proof only on existing broad chat.abort response', () => {
  const text = sources.get('chat-abort-handler-csuIgsSO.mjs');
  assert.equal(
    text.split(
      'preExecutionInputCancellations: res.preExecutionInputCancellations',
    ).length,
    2,
  );
  assert.ok(text.includes('runIds: res.runIds,'));
});

test('execution beginning inside native abortability hook prevents prelude proof', () => {
  const f = fixture();
  f.entry.isAbortable = () => {
    f.registered.markExecutionStarted();
    return true;
  };
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
test('queued ownership appearing during abort prevents prelude proof', () => {
  const f = fixture();
  f.setLifecycle(() =>
    f.context.chatQueuedTurns.set('input', { controller: f.entry.controller }),
  );
  assert.equal(f.cancel().preExecutionInputCancellations, undefined);
});
