import { z } from 'zod';
import type { PendingMessage, SettingsOperation } from '@messenger/contracts';
import {
  pendingSchema,
  resultSchema,
  settingsOperationSchema,
} from '../schemas.js';
import { removeInputFiles, trackInputFiles } from '../uploads/shared-files.js';
import type { SqlDatabase, Store } from './store.js';
import { ChatStore } from './chat-store.js';
import { initializeStore } from './schema.js';

export class SqlStore extends ChatStore implements Store {
  constructor(db: SqlDatabase) {
    super(db);
    initializeStore(db);
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
}
