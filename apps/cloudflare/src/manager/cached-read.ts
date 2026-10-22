import type { ChatSummary } from '@messenger/contracts';
import type { Store } from '../../../backend/src/storage/store.js';
import { summary } from '../../../backend/src/chats/service-record.js';
/** Reading cached conversation content is manager-local and never starts native work. */
export function markCachedRead(
  store: Store,
  commandId: string,
  chatId: string,
): { chat: ChatSummary } {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS manager_read_receipts (id TEXT PRIMARY KEY, json TEXT NOT NULL)',
  );
  return store.db.transaction(() => {
    const previous = store.db
      .prepare('SELECT json FROM manager_read_receipts WHERE id = ?')
      .get(commandId) as { json: string } | undefined;
    if (previous) return JSON.parse(previous.json) as { chat: ChatSummary };
    const chat = store.getChat(chatId);
    chat.unread = false;
    chat.updatedAt = Date.now();
    store.saveChat(chat);
    const result = { chat: summary(chat) };
    store.db
      .prepare('INSERT INTO manager_read_receipts (id, json) VALUES (?, ?)')
      .run(commandId, JSON.stringify(result));
    return result;
  })();
}
