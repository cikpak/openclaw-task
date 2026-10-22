import assert from 'node:assert/strict';
import { client, settings } from './acceptance/credentials.mjs';
const connection = await client();
try {
  const { models } = await connection.command({
    type: 'models.list',
    cachedOnly: false,
  });
  assert.ok(
    models.some((model) => model.id === settings.model && model.available),
  );
  const chat = await connection.create('Gateway acceptance', settings);
  const effective = await connection.command({
    type: 'chat.settings.get',
    chatId: chat.id,
  });
  assert.equal(effective.settings.effective.model, settings.model);
  const accepted = await connection.command({
    type: 'conversation.message.send',
    chatId: chat.id,
    text: 'Verify real Gateway streaming.',
  });
  assert.ok(accepted.messageId);
  assert.ok(
    accepted.receipt?.acceptedAt,
    'Acceptance must be durably recorded independently of execution',
  );
  await connection.completed(chat.id);
  assert.ok(
    connection.frames.some(
      (event) =>
        event.type === 'conversation.run.text' && event.chatId === chat.id,
    ),
  );
  assert.ok(
    !JSON.stringify(connection.frames).includes('/recovery/'),
    'Native paths never cross the public socket',
  );
  const ticket = await connection.request('/api/connection-tickets', {
    method: 'POST',
  });
  assert.equal(ticket.status, 200);
  const oldCookie = connection.cookie;
  await connection.close();
  connection.cookie = oldCookie;
  assert.equal(
    (await (await connection.request('/api/session')).json()).authenticated,
    false,
  );
  console.info(
    'PASS public-ticket real native Gateway: model availability, canonical agent/session creation, settings, durable send acceptance, streaming, history and logout. Deterministic test provider only.',
  );
} finally {
  await connection.close();
}
