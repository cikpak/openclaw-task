import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { client, settings } from './acceptance/credentials.mjs';
import { until } from './acceptance/client.mjs';
const connection = await client();
const timings = [],
  phases = [],
  observations = [];
const status = async () => {
  const response = await fetch(`${connection.origin}/__acceptance/status`);
  assert.equal(response.status, 200);
  const value = await response.json();
  if (phases.at(-1)?.phase !== value.phase)
    phases.push({ phase: value.phase, at: Date.now(), bootId: value.bootId });
  for (const [event, active] of [
    ['helper-ready', value.helperReady],
    ['start-complete', value.gatewayProcess === 'running'],
    ['sdk-authenticated', value.sdkReady],
  ]) {
    if (
      active &&
      !observations.some(
        (entry) => entry.bootId === value.bootId && entry.event === event,
      )
    )
      observations.push({ event, at: Date.now(), bootId: value.bootId });
  }
  return value;
};
try {
  await connection.deleteChats();
  const chat = await connection.create(
    'Lifecycle continuity acceptance',
    settings,
  );
  await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'TOOL_WRITE_DOC_FIXTURE',
  });
  await connection.completed(chat.id, 'Generated document ready.');
  const first = await status();
  const { files } = await connection.command({
    type: 'files.list',
    chatId: chat.id,
    category: 'generated',
  });
  const file = files.find((entry) => entry.name === 'artifact-fixture.txt');
  assert.ok(file);
  const stoppedAt = Date.now();
  await until(
    async () => {
      const current = await status();
      return (
        current.phase === 'asleep' &&
        current.initialized &&
        !current.running &&
        current.generation
      );
    },
    'Idle native engine must preserve to local S3/R2 and stop',
    300_000,
  );
  timings.push({
    segment: 'idle-preserve-stop',
    durationMs: Date.now() - stoppedAt,
  });
  const sleeping = await status();
  const resolved = await connection.command({
    type: 'files.resolve',
    chatId: chat.id,
    fileId: file.id,
  });
  const download = await connection.request(resolved.download.url);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'TOOL_FILE_TOKEN');
  assert.equal(
    (await status()).running,
    false,
    'Committed R2 download must not wake engine',
  );
  assert.equal((await status()).bootId, sleeping.bootId);
  const sentAt = Date.now();
  const accepted = await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'Continue the original conversation after restore.',
  });
  assert.ok(accepted.receipt?.acceptedAt);
  timings.push({
    segment: 'durable-acceptance',
    durationMs: Date.now() - sentAt,
  });
  const poll = setInterval(() => {
    void status();
  }, 200);
  let restored;
  try {
    restored = await connection.completed(chat.id);
  } finally {
    clearInterval(poll);
  }
  assert.equal(restored.chat.id, chat.id);
  assert.ok(
    restored.messages.some((message) =>
      message.text.includes('Generated document ready.'),
    ),
  );
  assert.ok(
    restored.messages.some((message) =>
      message.text.includes(
        'Continue the original conversation after restore.',
      ),
    ),
  );
  const resumed = await status();
  assert.notEqual(
    resumed.bootId,
    first.bootId,
    'Wake must use a fresh container boot',
  );
  assert.equal(resumed.generation, sleeping.generation);
  const boundaries = Object.fromEntries(
    [
      ...observations.filter((entry) => entry.bootId === resumed.bootId),
      ...resumed.timings,
    ].map((entry) => [entry.event, entry.at]),
  );
  for (const [segment, start, end] of [
    ['helper-startup', 'helper-start', 'helper-ready'],
    ['restore', 'restore-start', 'restore-complete'],
    ['gateway-process-start', 'start-start', 'start-complete'],
    ['sdk-authentication', 'start-complete', 'sdk-authenticated'],
    ['dispatch', 'sdk-authenticated', 'dispatch'],
  ]) {
    assert.equal(
      typeof boundaries[start],
      'number',
      `${segment} start boundary required`,
    );
    assert.equal(
      typeof boundaries[end],
      'number',
      `${segment} end boundary required`,
    );
    assert.ok(boundaries[end] >= boundaries[start]);
    timings.push({ segment, durationMs: boundaries[end] - boundaries[start] });
  }

  const effective = await connection.command({
    type: 'chat.settings.get',
    chatId: chat.id,
  });
  assert.equal(effective.settings.effective.model, settings.model);
  await writeFile(
    '.context/cloudflare-local-lifecycle-evidence.json',
    JSON.stringify(
      {
        provider: 'deterministic-local-test-only',
        chatContinued: true,
        asleepDownload: true,
        timings,
        phases,
        nativeBoundaries: resumed.timings,
        healthBoundaryObservations: observations,
        observationResolutionMs: 200,
        completedAt: Date.now(),
      },
      null,
      2,
    ),
  );
  console.info(
    'PASS real local Cloudflare send/execute/idle/preserve/stop/asleep R2 download/fresh boot/restore/same-chat continuation. Deterministic test provider; no production-provider pass or startup SLA claimed.',
  );
} finally {
  await connection.close();
}
