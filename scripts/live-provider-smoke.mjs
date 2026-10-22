import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AcceptanceClient, until } from './acceptance/client.mjs';
// Chargeable opt-in; never part of deterministic automated acceptance.
assert.equal(
  process.env.LIVE_PROVIDER_SMOKE,
  '1',
  'LIVE_PROVIDER_SMOKE=1 is required',
);
assert.ok(
  process.env.LIVE_PROVIDER_PASSWORD_FILE,
  'Use a private password file',
);
assert.ok(
  process.env.LIVE_PROVIDER_ORIGIN,
  'Select the deployed public origin explicitly',
);
assert.ok(
  process.env.LIVE_PROVIDER_MODEL &&
    !process.env.LIVE_PROVIDER_MODEL.startsWith('mock/'),
  'Select a real provider model',
);
const connection = await new AcceptanceClient(
  process.env.LIVE_PROVIDER_ORIGIN,
  process.env.LIVE_PROVIDER_USERNAME ?? 'admin',
  await readFile(process.env.LIVE_PROVIDER_PASSWORD_FILE, 'utf8'),
).login();
let chat;
try {
  const { models } = await connection.command({
    type: 'models.list',
    cachedOnly: false,
  });
  const model = models.find(
    (item) => item.id === process.env.LIVE_PROVIDER_MODEL && item.available,
  );
  assert.ok(model, 'Selected provider must be available');
  chat = await connection.create(`Disposable smoke ${randomUUID()}`, {
    model: model.id,
    thinkingLevel: model.thinkingDefault,
    fastMode: false,
    customInstructions: '',
    responseStyle: 'default',
    personality: 'neutral',
  });
  await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'Reply with a short greeting. Do not call tools.',
  });
  await until(
    async () => {
      const snapshot = await connection.snapshot(chat.id);
      return (
        !snapshot.activeRun &&
        !snapshot.pending.length &&
        snapshot.messages.some(
          (message) => message.role === 'assistant' && message.text.trim(),
        )
      );
    },
    'A nonempty completed canonical provider response is required',
    180_000,
  );
  console.info(
    'PASS opt-in public-origin live provider smoke: secure session, one-use ticket, native model, durable input and completed canonical response. No content or secrets logged.',
  );
} finally {
  if (chat) {
    const current = await connection.command({
      type: 'chat.get',
      chatId: chat.id,
    });
    await connection.command({
      type: 'chat.delete',
      chatId: chat.id,
      version: current.chat.version,
    });
  }
  await connection.close();
}
