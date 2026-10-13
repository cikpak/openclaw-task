import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatSummary } from '@messenger/contracts';
import { z } from 'zod';
import {
  chatSchema,
  pendingSchema,
  resultSchema,
  settingsOperationSchema,
} from './schemas.js';
import type { PendingMessage, SettingsOperation } from '@messenger/contracts';
import { ConflictError, NotFoundError } from './errors.js';
import {
  initializeSharedFiles,
  trackInputFiles,
  removeInputFiles,
} from './uploads/shared-files.js';

export interface ChatRecord extends ChatSummary {
  agentId: string | null;
  sessionKey: string | null;
  creationId: string;
}
export interface ChatMetadata {
  manualName: boolean;
  creationInput: unknown;
  titleText?: string | undefined;
  titleFallback?: string | undefined;
  titleRequested?: boolean | undefined;
}
const rowSchema = z.object({
  id: z.string(),
  json: z.string(),
  agent_id: z.string().nullable(),
  session_key: z.string().nullable(),
  creation_id: z.string(),
});
export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, json TEXT NOT NULL, agent_id TEXT UNIQUE, session_key TEXT UNIQUE, creation_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_results (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(chat_id, position));
      CREATE TABLE IF NOT EXISTS settings_operations (chat_id TEXT PRIMARY KEY REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_metadata (chat_id TEXT PRIMARY KEY REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_requests (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_history (chat_id TEXT PRIMARY KEY REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_scopes (message_id TEXT PRIMARY KEY REFERENCES pending_messages(id) ON DELETE CASCADE, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS creation_commands (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deletion_tombstones (chat_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_tools (chat_id TEXT NOT NULL REFERENCES chats(id), id TEXT NOT NULL, sequence INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(chat_id, id));
      INSERT OR IGNORE INTO creation_commands (id, chat_id, json) SELECT creation_id, id, 'null' FROM chats;
      INSERT OR IGNORE INTO migrations VALUES (1, unixepoch() * 1000);
      INSERT OR IGNORE INTO migrations VALUES (2, unixepoch() * 1000);
    `);
    initializeSharedFiles(this.db);
    if (
      !this.db.prepare('SELECT version FROM migrations WHERE version = 3').get()
    ) {
      this.db.transaction(() => {
        // Drop only observations. Never expire mutation identities or uncertain receipts.
        this.db.exec(`
          DELETE FROM command_results WHERE id IN (
            SELECT id FROM command_requests WHERE
              CASE WHEN json_valid(json) THEN json_extract(json, '$.type') END
                IN ('conversation.snapshot.request', 'conversation.history.request')
          );
          DELETE FROM command_requests WHERE
            CASE WHEN json_valid(json) THEN json_extract(json, '$.type') END
              IN ('conversation.snapshot.request', 'conversation.history.request');
          INSERT INTO migrations VALUES (3, unixepoch() * 1000);
        `);
      })();
    }
  }
  close(): void {
    this.db.close();
  }
  createSession(id: string, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO sessions (id, expires_at) VALUES (?, ?)')
      .run(id, expiresAt);
  }
  sessionValid(id: string, now = Date.now()): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT id FROM sessions WHERE id = ? AND revoked = 0 AND expires_at > ?',
        )
        .get(id, now),
    );
  }
  revokeSession(id: string): void {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').run(id);
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
  pending(id: string): PendingMessage[] {
    return this.db
      .prepare(
        'SELECT json FROM pending_messages WHERE chat_id = ? ORDER BY position',
      )
      .all(id)
      .map((row) => pendingSchema.parse(this.parseJson(row)));
  }
  savePending(item: PendingMessage): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO pending_messages VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
        )
        .run(
          item.id,
          item.chatId,
          item.position,
          JSON.stringify(pendingSchema.parse(item)),
        );
      trackInputFiles(this.db, item);
    })();
  }
  removePending(
    id: string,
    outcome: 'removed' | 'consumed' | 'cancelled' = 'removed',
  ): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT json FROM pending_messages WHERE id=?')
        .get(id);
      if (row)
        removeInputFiles(
          this.db,
          pendingSchema.parse(this.parseJson(row)),
          outcome,
        );
      this.db.prepare('DELETE FROM pending_messages WHERE id = ?').run(id);
    })();
  }
  submissionScope(id: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM submission_scopes WHERE message_id = ?')
      .get(id);
    return row
      ? z.object({ session_id: z.string() }).parse(row).session_id
      : null;
  }
  saveSubmissionScope(id: string, sessionId: string): void {
    this.db
      .prepare(
        'INSERT INTO submission_scopes VALUES (?, ?) ON CONFLICT(message_id) DO UPDATE SET session_id = excluded.session_id',
      )
      .run(id, sessionId);
  }
  settingsOperation(id: string): SettingsOperation | null {
    const row = this.db
      .prepare('SELECT json FROM settings_operations WHERE chat_id = ?')
      .get(id);
    return row ? settingsOperationSchema.parse(this.parseJson(row)) : null;
  }
  saveSettingsOperation(
    chatId: string,
    operation: SettingsOperation | null,
  ): void {
    if (operation)
      this.db
        .prepare(
          'INSERT INTO settings_operations VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
        )
        .run(chatId, JSON.stringify(settingsOperationSchema.parse(operation)));
    else
      this.db
        .prepare('DELETE FROM settings_operations WHERE chat_id = ?')
        .run(chatId);
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
  commandRequest(id: string): string | null {
    const row = this.db
      .prepare('SELECT json FROM command_requests WHERE id = ?')
      .get(id);
    return row ? z.object({ json: z.string() }).parse(row).json : null;
  }
  saveCommandRequest(id: string, json: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO command_requests VALUES (?, ?)')
      .run(id, json);
  }
  private parseJson(row: unknown): unknown {
    return JSON.parse(
      z.object({ json: z.string() }).parse(row).json,
    ) as unknown;
  }
  getCommand(id: string): z.infer<typeof resultSchema> | null {
    const row = this.db
      .prepare('SELECT json FROM command_results WHERE id = ?')
      .get(id) as { json: string } | undefined;
    return row ? resultSchema.parse(JSON.parse(row.json)) : null;
  }
  saveCommand(result: z.infer<typeof resultSchema>): void {
    this.db
      .prepare('INSERT OR IGNORE INTO command_results VALUES (?, ?, ?)')
      .run(
        result.commandId,
        JSON.stringify(resultSchema.parse(result)),
        Date.now(),
      );
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
