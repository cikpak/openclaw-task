import type { ChatSnapshot, HistoryViewport } from '@messenger/contracts';
import type { Store } from '../../../backend/src/storage/store.js';
import { recentMessages } from './cached.js';
const initialViewport: HistoryViewport = {
  width: 816,
  height: 720,
  fontSize: 16,
  lineHeight: 27.2,
};
function table(store: Store) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS history_viewports (chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE, json TEXT NOT NULL)',
  );
}
export function rememberViewport(
  store: Store,
  chatId: string,
  viewport: HistoryViewport,
) {
  table(store);
  store.db
    .prepare(
      'INSERT OR REPLACE INTO history_viewports (chat_id, json) VALUES (?, ?)',
    )
    .run(chatId, JSON.stringify(viewport));
}
/** Native transcripts remain authoritative; trim only when their stable record anchor exists. */
export function pruneCachedSnapshot(
  store: Store,
  snapshot: ChatSnapshot,
): ChatSnapshot {
  table(store);
  const row = store.db
    .prepare('SELECT json FROM history_viewports WHERE chat_id = ?')
    .get(snapshot.chat.id) as { json: string } | undefined;
  const viewport = row
    ? (JSON.parse(row.json) as HistoryViewport)
    : initialViewport;
  const messages = recentMessages(snapshot.messages, viewport);
  if (messages.length === snapshot.messages.length) return snapshot;
  const sequence = messages[0]?.historySequence;
  // Legacy imports without native record positions cannot be trimmed without losing a safe older cursor.
  if (!sequence || !Number.isSafeInteger(sequence)) return snapshot;
  return {
    ...snapshot,
    messages,
    historyCursor: `before:${sequence}`,
    hasOlderHistory: true,
  };
}
