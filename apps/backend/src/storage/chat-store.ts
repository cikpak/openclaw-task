import { z } from 'zod';
import { chatSchema } from '../schemas.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { ChatRecord, ChatMetadata, SqlDatabase } from './store.js';

const rowSchema = z.object({
  id: z.string(),
  json: z.string(),
  agent_id: z.string().nullable(),
  session_key: z.string().nullable(),
  creation_id: z.string(),
});
export class ChatStore {
  constructor(readonly db: SqlDatabase) {}
  protected parseJson(row: unknown): unknown {
    return JSON.parse(
      z.object({ json: z.string() }).parse(row).json,
    ) as unknown;
  }
  listChats(): ChatRecord[] {
    return this.db
      .prepare('SELECT * FROM chats ORDER BY rowid')
      .all()
      .map((row) => this.decodeChat(row));
  }
  getChat(id: string): ChatRecord {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    if (!row) throw new NotFoundError();
    return this.decodeChat(row);
  }
  findCreation(creationId: string): ChatRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM chats WHERE creation_id = ?')
      .get(creationId);
    return row ? this.decodeChat(row) : undefined;
  }
  reserveChat(chat: ChatRecord): void {
    this.db.transaction(() => {
      const count = this.db
        .prepare('SELECT count(*) AS count FROM chats')
        .get() as { count: number };
      if (count.count >= 10)
        throw new ConflictError('CHAT_LIMIT', 'You can have up to ten chats.');
      this.db
        .prepare('INSERT INTO chats VALUES (?, ?, ?, ?, ?)')
        .run(
          chat.id,
          JSON.stringify(chatSchema.parse(chat)),
          chat.agentId,
          chat.sessionKey,
          chat.creationId,
        );
    })();
  }
  saveChat(chat: ChatRecord): void {
    this.db
      .prepare(
        'UPDATE chats SET json = ?, agent_id = ?, session_key = ? WHERE id = ?',
      )
      .run(
        JSON.stringify(chatSchema.parse(chat)),
        chat.agentId,
        chat.sessionKey,
        chat.id,
      );
  }
  removeChat(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE creation_commands SET deleted = 1 WHERE chat_id = ?')
        .run(id);
      for (const table of [
        'pending_messages',
        'settings_operations',
        'chat_metadata',
        'chat_history',
        'chat_tools',
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE chat_id = ?`).run(id);
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
    })();
  }
  creationCommand(
    id: string,
  ): { chatId: string; input: string; deleted: boolean } | null {
    const row = this.db
      .prepare(
        'SELECT chat_id, json, deleted FROM creation_commands WHERE id = ?',
      )
      .get(id);
    if (!row) return null;
    const data = z
      .object({ chat_id: z.string(), json: z.string(), deleted: z.number() })
      .parse(row);
    return {
      chatId: data.chat_id,
      input: data.json,
      deleted: Boolean(data.deleted),
    };
  }
  saveCreationCommand(id: string, chatId: string, input: unknown): void {
    this.db
      .prepare(
        'INSERT INTO creation_commands (id, chat_id, json) VALUES (?, ?, ?)',
      )
      .run(id, chatId, JSON.stringify(input));
  }
  saveTombstone(chat: ChatRecord): void {
    this.db
      .prepare(
        'INSERT INTO deletion_tombstones VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      )
      .run(chat.id, JSON.stringify(chat));
  }
  tombstones(): ChatRecord[] {
    return this.db
      .prepare('SELECT json FROM deletion_tombstones ORDER BY rowid')
      .all()
      .map((row) => {
        const value = this.parseJson(row);
        return {
          ...chatSchema.parse(value),
          ...z
            .object({
              agentId: z.string().nullable(),
              sessionKey: z.string().nullable(),
              creationId: z.string(),
            })
            .parse(value),
        };
      });
  }
  metadata(id: string): ChatMetadata {
    const row = this.db
      .prepare('SELECT json FROM chat_metadata WHERE chat_id = ?')
      .get(id);
    return row
      ? z
          .object({
            manualName: z.boolean(),
            creationInput: z.unknown(),
            titleText: z.string().optional(),
            titleFallback: z.string().optional(),
            titleRequested: z.boolean().optional(),
          })
          .parse(this.parseJson(row))
      : { manualName: false, creationInput: null };
  }
  saveMetadata(id: string, data: ChatMetadata): void {
    this.db
      .prepare(
        'INSERT INTO chat_metadata VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      )
      .run(id, JSON.stringify(data));
  }
  private decodeChat(value: unknown): ChatRecord {
    const row = rowSchema.parse(value);
    return {
      ...chatSchema.parse(JSON.parse(row.json)),
      agentId: row.agent_id,
      sessionKey: row.session_key,
      creationId: row.creation_id,
    };
  }
}
