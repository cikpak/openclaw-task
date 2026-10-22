import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { providerStats, sampleResources } from './acceptance/docker.mjs';
import { until } from './acceptance/client.mjs';
import { client, settings } from './acceptance/credentials.mjs';
const connection = await client();
try {
  await connection.deleteChats();
  const chats = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      connection.create(`Capacity ${index}`, settings),
    ),
  );
  assert.equal(new Set(chats.map((chat) => chat.id)).size, 10);
  const rejected = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      connection.command({
        type: 'chat.create',
        name: 'Rejected eleventh',
        settings,
      }),
    ),
  );
  for (const result of rejected) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.code, 'CHAT_LIMIT');
  }
  const baseline = await sampleResources();
  await Promise.all(
    chats.map((chat, index) =>
      connection.command({
        type: 'conversation.message.send',
        chatId: chat.id,
        text: `CAPACITY_RESPONSE_FIXTURE CAPACITY_CHAT_${index}`,
      }),
    ),
  );
  await until(
    async () => (await providerStats()).capacity.active === 10,
    'All ten native requests must actually overlap at the provider',
    45_000,
  );
  const stats = (await providerStats()).capacity;
  assert.equal(stats.peak, 10);
  assert.equal(
    stats.calls,
    10,
    'One logical provider call per accepted unique input',
  );
  const concurrent = await sampleResources();
  const snapshots = await Promise.all(
    chats.map((chat, index) =>
      connection.completed(chat.id, `CAPACITY_CHAT_${index}`),
    ),
  );
  for (const [index, snapshot] of snapshots.entries()) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(snapshot)) < 256 * 1024,
      'This small test snapshot remains bounded without imposing a retention count',
    );
    assert.equal(
      snapshot.messages.filter((message) => message.role === 'assistant')
        .length,
      1,
    );
    for (let other = 0; other < 10; other++)
      if (other !== index)
        assert.ok(
          !snapshot.messages.some((message) =>
            message.text.includes(`CAPACITY_CHAT_${other}`),
          ),
          'No cross-chat transcript leakage',
        );
  }
  await writeFile(
    '.context/resource-evidence.json',
    JSON.stringify(
      {
        provider: 'deterministic-local',
        completedAgents: 10,
        providerStats: stats,
        baseline,
        concurrent,
        completed: await sampleResources(),
        rejectedConcurrentCreates: 4,
        snapshotBytes: snapshots.map((snapshot) =>
          Buffer.byteLength(JSON.stringify(snapshot)),
        ),
      },
      null,
      2,
    ),
  );
  console.info(
    'PASS ten real native agent runs, four concurrent excess creates rejected, unique transcript isolation. No fixed history-count retention assertion or external-model benchmark.',
  );
} finally {
  await connection.close();
}
