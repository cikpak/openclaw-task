import type { ToolActivity } from '@messenger/contracts';
import { z } from 'zod';
import type { Store } from '../storage/store.js';
const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  parameters: z.string().max(4096),
  output: z.string().max(8192),
});
export function tools(store: Store, chatId: string): ToolActivity[] {
  return store.db
    .prepare(
      'SELECT json FROM chat_tools WHERE chat_id = ? ORDER BY rowid DESC LIMIT 100',
    )
    .all(chatId)
    .map((row) =>
      toolSchema.parse(
        JSON.parse(z.object({ json: z.string() }).parse(row).json),
      ),
    )
    .reverse();
}
export function saveTool(
  store: Store,
  chatId: string,
  input: ToolActivity,
  sequence: number,
): ToolActivity | null {
  const tool = toolSchema.parse(input);
  if (tool.id.startsWith('history:')) {
    const callId = tool.id.slice('history:'.length);
    const matches = tools(store, chatId).filter(
      (candidate) =>
        !candidate.id.startsWith('history:') &&
        candidate.id.endsWith(`:${callId}`),
    );
    if (matches.length === 1 && matches[0]) tool.id = matches[0].id;
  } else {
    const matches = tools(store, chatId).filter(
      (candidate) =>
        candidate.id.startsWith('history:') &&
        tool.id.endsWith(`:${candidate.id.slice('history:'.length)}`),
    );
    if (matches.length === 1 && matches[0]) {
      const previous = matches[0];
      if (!tool.parameters) tool.parameters = previous.parameters;
      if (previous.status !== 'running' && tool.status === 'running')
        return null;
      store.db
        .prepare('DELETE FROM chat_tools WHERE chat_id = ? AND id = ?')
        .run(chatId, previous.id);
    }
  }
  const row = store.db
    .prepare(
      'SELECT sequence, json FROM chat_tools WHERE chat_id = ? AND id = ?',
    )
    .get(chatId, tool.id);
  if (row) {
    const current = z
      .object({ sequence: z.number(), json: z.string() })
      .parse(row);
    const previous = toolSchema.parse(JSON.parse(current.json));
    if (!tool.parameters && previous.parameters)
      tool.parameters = previous.parameters;
    if (previous.status !== 'running' && tool.status === 'running') return null;
    if (
      current.sequence >= sequence &&
      !(
        sequence === -1 &&
        previous.status === 'running' &&
        tool.status !== 'running'
      )
    )
      return null;
  }
  store.db
    .prepare(
      'INSERT INTO chat_tools VALUES (?, ?, ?, ?) ON CONFLICT(chat_id,id) DO UPDATE SET sequence = excluded.sequence, json = excluded.json',
    )
    .run(chatId, tool.id, sequence, JSON.stringify(tool));
  store.db
    .prepare(
      'DELETE FROM chat_tools WHERE chat_id = ? AND rowid NOT IN (SELECT rowid FROM chat_tools WHERE chat_id = ? ORDER BY rowid DESC LIMIT 100)',
    )
    .run(chatId, chatId);
  return tool;
}
