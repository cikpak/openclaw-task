import type {
  ChatSnapshot,
  HistoryViewport,
  Message,
} from '@messenger/contracts';
import { summary } from '../../../backend/src/chats/service-record.js';
import { snapshotSchema } from '../../../backend/src/schemas.js';
import { tools } from '../../../backend/src/chats/tools.js';
import type { Store } from '../../../backend/src/storage/store.js';

export function cachedSnapshot(store: Store, id: string): ChatSnapshot {
  const row = store.db
    .prepare('SELECT json FROM chat_history WHERE chat_id = ?')
    .get(id) as { json: string } | undefined;
  const history = row ? snapshotSchema.parse(JSON.parse(row.json)) : undefined;
  return snapshotSchema.parse({
    chat: summary(store.getChat(id)),
    messages: history?.messages ?? [],
    pending: store.pending(id),
    activeRun: null,
    pendingSettings: store.settingsOperation(id),
    hasOlderHistory: history?.hasOlderHistory ?? false,
    historyCursor: history?.historyCursor ?? null,
    tools: tools(store, id),
  });
}
/** Estimate rendered height from content and viewport; retain completed messages whole. */
export function recentMessages(
  messages: Message[],
  viewport: HistoryViewport,
): Message[] {
  const columns = Math.max(
    12,
    Math.floor((viewport.width - 64) / (viewport.fontSize * 0.55)),
  );
  const selected: Message[] = [];
  let height = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'tool') continue;
    selected.unshift(message);
    height +=
      message.text
        .split('\n')
        .reduce(
          (lines, line) =>
            lines + Math.max(1, Math.ceil(line.length / columns)),
          0,
        ) *
        viewport.lineHeight +
      48;
    height += (message.attachments?.length ?? 0) * 64;
    if (height >= viewport.height * 2) {
      // One native record can project to multiple public messages. Keep that boundary group whole.
      const sequence = message.historySequence;
      while (
        sequence !== undefined &&
        index > 0 &&
        messages[index - 1]?.historySequence === sequence
      ) {
        index -= 1;
        if (messages[index]!.role !== 'tool')
          selected.unshift(messages[index]!);
      }
      break;
    }
  }
  return selected;
}
