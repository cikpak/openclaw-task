import type { ChatService } from '../../../backend/src/chats/service.js';
import type { Store } from '../../../backend/src/storage/store.js';
import type { Gateway } from '../../../backend/src/gateway/types.js';

/** A durable create intent is materialized with the same deterministic native ID. */
export async function materializeChats(
  store: Store,
  gateway: Gateway,
  service: ChatService,
): Promise<void> {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS native_creation_intents (chat_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, state TEXT NOT NULL)',
  );
  for (const original of store.listChats()) {
    if (
      original.status !== 'creating' ||
      original.agentId ||
      original.sessionKey
    )
      continue;
    await service.withLock(original.id, async () => {
      const chat = store.getChat(original.id);
      if (
        chat.status !== 'creating' ||
        chat.agentId ||
        chat.sessionKey ||
        !gateway.ready
      )
        return;
      // agents.list reads native committed configuration. Recover before every
      // retry, including a lost create ACK or manager restart. Native create uses
      // the deterministic messenger-<chatId> identity and refuses duplicates.
      let found = await gateway.recoverCreation?.(chat.id, chat.settings);
      const recovered = store.getChat(chat.id);
      if (
        recovered.status !== 'creating' ||
        recovered.agentId ||
        recovered.sessionKey ||
        !gateway.ready
      )
        return;
      if (!found) {
        store.db
          .prepare(
            'INSERT INTO native_creation_intents VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state',
          )
          .run(chat.id, crypto.randomUUID(), 'creating');
        try {
          found = await gateway.create(chat.id, chat.settings);
        } catch {
          store.db
            .prepare(
              'UPDATE native_creation_intents SET state = ? WHERE chat_id = ?',
            )
            .run('unknown', chat.id);
          return;
        }
      }
      const current = store.getChat(chat.id);
      if (current.status !== 'creating') return;
      current.agentId = found.agentId;
      current.sessionKey = found.sessionKey;
      store.saveChat(current);
      store.db
        .prepare(
          'UPDATE native_creation_intents SET state = ? WHERE chat_id = ?',
        )
        .run('confirmed', chat.id);
    });
  }
}
