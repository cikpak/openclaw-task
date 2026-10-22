import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, input, nativeSources } from './native-owner-fixture.mjs';
const sources = nativeSources();
test('deferred ordinary admission snapshots its exact proof before a later retry can rebind it', async () => {
  const f = fixture(sources),
    recorder = f.recorder(input());
  let release, started;
  const admitted = new Promise((resolve) => {
    started = resolve;
  });
  recorder.setAdmissionHandler(() => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  await recorder.confirmMessengerProcessingForPersistence('first-owner');
  const first = recorder.persistApproved();
  await admitted;
  const second =
    recorder.confirmMessengerProcessingForPersistence('second-owner');
  release();
  await first;
  await second;
  await f.provider(recorder);
  assert.equal(
    f.records.get('client-input:user').__openclaw.messengerProcessing.runId,
    'second-owner',
  );
});
test('overlapping failed canonical confirmation cannot adopt another retry owner or reach the provider', async () => {
  const f = fixture(sources),
    recorder = f.recorder(input());
  await recorder.persistApproved();
  let release, started;
  f.state.pauseRewrite = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  f.state.rewriteStarted = started;
  const first =
    recorder.confirmMessengerProcessingForPersistence('failed-owner');
  await entered;
  const next = recorder.confirmMessengerProcessingForPersistence('retry-owner');
  f.state.generation++;
  release();
  await assert.rejects(() => first, /invalidated/);
  await assert.rejects(() => next, /invalidated/);
  await assert.rejects(() => f.provider(recorder));
  assert.equal(f.state.provider, 0);
});
test('staged canonical proof write failure and post-commit generation change block the provider', async () => {
  const f = fixture(sources),
    recorder = f.recorder(input());
  await recorder.stageApproved();
  await recorder.confirmMessengerProcessingForPersistence('owner');
  f.state.failRewrite = true;
  await assert.rejects(() => recorder.persistApproved(), /invalidated/);
  await assert.rejects(() => f.provider(recorder));
  assert.equal(f.state.provider, 0);
  const good = fixture(sources),
    complete = good.recorder(input());
  await complete.persistApproved();
  await complete.confirmMessengerProcessingForPersistence('owner');
  good.state.generation++;
  await assert.rejects(() => good.provider(complete), /not durably committed/);
  assert.equal(good.state.provider, 0);
});
