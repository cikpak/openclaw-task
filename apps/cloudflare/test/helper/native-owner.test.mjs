import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, input, nativeSources } from './native-owner-fixture.mjs';
const sources = nativeSources();

test('actual pinned cached recorder keeps native admission timing and commits proof before provider', async () => {
  const f = fixture(sources);
  const message = input();
  Object.freeze(message.__openclaw);
  Object.freeze(message);
  const recorder = f.recorder(message);
  await recorder.resolveMessage();
  await recorder.confirmMessengerProcessingForPersistence('generated-followup');
  assert.equal(
    f.state.writes,
    0,
    'confirmation must not manufacture canonical admission',
  );
  await assert.rejects(() => f.provider(recorder), /not durably committed/);
  assert.equal(f.state.provider, 0);
  await recorder.persistApproved(); // Existing native admission, not a new patch call.
  await f.provider(recorder);
  assert.equal(f.state.provider, 1);
  assert.deepEqual(
    f.records.get(message.idempotencyKey).__openclaw.messengerProcessing,
    { runId: 'generated-followup', keys: [message.idempotencyKey] },
  );
});

test('actual staged native message retains its approved bytes and gains proof at canonical commit', async () => {
  const f = fixture(sources);
  const recorder = f.recorder(input());
  await recorder.resolveMessage();
  await recorder.stageApproved();
  await recorder.confirmMessengerProcessingForPersistence('generated-followup');
  assert.equal(
    (await recorder.resolveMessage()).__openclaw.messengerProcessing,
    undefined,
  );
  assert.equal(f.state.writes, 0);
  await recorder.persistApproved();
  await f.provider(recorder);
  assert.equal(f.state.provider, 1);
  assert.equal(
    f.records.get('client-input:user').__openclaw.messengerProcessing.runId,
    'generated-followup',
  );
});

test('actual patched followup wrapper binds its generated owner before existing execution without admitting work early', async () => {
  const f = fixture(sources);
  const recorder = f.recorder(input());
  await recorder.resolveMessage();
  await f.followup(recorder, async () => {
    assert.equal(f.state.writes, 0);
    await recorder.persistApproved();
    return f.provider(recorder);
  });
  assert.equal(f.state.provider, 1);
  assert.equal(
    f.records.get('client-input:user').__openclaw.messengerProcessing.runId,
    'generated-followup',
  );
});

test('already canonical recorder awaits exact anchor rewrite and supports a new admitted retry owner', async () => {
  const f = fixture(sources);
  const recorder = f.recorder(input());
  await recorder.persistApproved();
  await recorder.resolveMessage();
  await recorder.confirmMessengerProcessingForPersistence('first-owner');
  await f.provider(recorder);
  await recorder.confirmMessengerProcessingForPersistence('retry-owner');
  await f.provider(recorder);
  assert.equal(
    f.records.get('client-input:user').__openclaw.messengerProcessing.runId,
    'retry-owner',
  );
});

for (const kind of ['collect', 'overflow'])
  test(`${kind} retains every exact native source key without a cap`, async () => {
    const f = fixture(sources);
    const sourceRecorders = Array.from({ length: 65 }, (_, index) =>
      f.recorder(input(`input-${index}:user`)),
    );
    const recorder = f.recorder(
      {
        role: 'user',
        idempotencyKey: `followup-${kind}:native-key`,
        content: 'Native aggregate',
      },
      { pendingInputSources: sourceRecorders },
    );
    await recorder.resolveMessage();
    await recorder.confirmMessengerProcessingForPersistence('aggregate-owner');
    assert.equal(f.state.writes, 0);
    await recorder.persistApproved();
    await f.provider(recorder);
    assert.deepEqual(
      f.records.get(`followup-${kind}:native-key`).__openclaw
        .messengerProcessing.keys,
      sourceRecorders.map((source) => source.message.idempotencyKey),
    );
  });

for (const failure of [
  'reset',
  'write',
  'publication',
  'blocked',
  'contradictory-steer',
])
  test(`selected ${failure} proof failure cannot invoke native baseStreamFn`, async () => {
    const f = fixture(sources);
    const recorder = f.recorder(
      input(
        'client-input:user',
        failure === 'contradictory-steer'
          ? { steerTargetRunId: 'different-owner' }
          : {},
      ),
    );
    await recorder.persistApproved();
    if (failure === 'reset') f.state.current = false;
    if (failure === 'write') f.state.failWrite = true;
    if (failure === 'publication') f.state.failPublish = true;
    if (failure === 'blocked') recorder.markBlocked();
    await assert.rejects(async () => {
      await recorder.confirmMessengerProcessingForPersistence(
        'generated-owner',
      );
      await f.provider(recorder);
    });
    assert.equal(f.state.provider, 0);
  });

test('post-commit reset and failed ordinary persistence keep provider blocked', async () => {
  const f = fixture(sources);
  const recorder = f.recorder(input());
  await recorder.confirmMessengerProcessingForPersistence('owner');
  f.state.failWrite = true;
  await assert.rejects(() => recorder.persistApproved());
  await assert.rejects(() => f.provider(recorder));
  assert.equal(f.state.provider, 0);
});

test('protected metadata survives runtime and in-place hook mutation but rejects forged additions', async () => {
  const f = fixture(sources);
  const recorder = f.recorder(input());
  await recorder.confirmMessengerProcessingForPersistence('owner');
  const original = await recorder.resolveMessage();
  const expected = structuredClone(original.__openclaw.messengerProcessing);
  const runtime = f.metadata.restorePreparedUserTurnOperationalMetaForRuntime({
    preparedMessage: original,
    runtimeMessage: {
      ...original,
      __openclaw: {
        messengerProcessing: { runId: 'forged', keys: ['foreign'] },
      },
    },
  });
  assert.deepEqual(runtime.__openclaw.messengerProcessing, expected);
  const protectedMessage =
    f.metadata.preparePersistedUserTurnMessageForTranscriptWrite(original, {
      beforeMessageWrite: ({ message }) => {
        message.__openclaw.messengerProcessing.runId = 'forged';
        return message;
      },
    });
  assert.deepEqual(protectedMessage.__openclaw.messengerProcessing, expected);
  const unproved = input();
  const sanitized =
    f.metadata.preparePersistedUserTurnMessageForTranscriptWrite(unproved, {
      beforeMessageWrite: ({ message }) => ({
        ...message,
        __openclaw: { ...message.__openclaw, messengerProcessing: expected },
      }),
    });
  assert.equal(sanitized.__openclaw.messengerProcessing, undefined);
});

test('unkeyed unmanaged native recorders retain their existing behavior', async () => {
  const f = fixture(sources);
  for (const message of [
    { role: 'user', content: 'Unmanaged' },
    {
      role: 'user',
      content: 'Other client',
      __openclaw: { transport: { clients: {} } },
    },
    {
      role: 'user',
      content: 'Malformed client',
      __openclaw: { transport: { clients: [null] } },
    },
  ]) {
    const recorder = f.recorder(message);
    assert.equal(
      await recorder.confirmMessengerProcessingForPersistence('owner'),
      false,
    );
    await f.provider(recorder);
  }
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.provider, 3);
});
