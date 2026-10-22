import type { Attachment } from '@messenger/contracts';
import type { Store } from '../../../../backend/src/storage/store.js';
import {
  ApplicationError,
  ConflictError,
  NotFoundError,
} from '../../../../backend/src/errors.js';
import type { UploadChunk, UploadRecord } from './types.js';
export class UploadDatabase {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS staged_uploads (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
      object_key TEXT NOT NULL, sha256 TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      received INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS staged_upload_chunks (
      upload_id TEXT NOT NULL, offset INTEGER NOT NULL, size INTEGER NOT NULL,
      sha256 TEXT NOT NULL, object_key TEXT NOT NULL, PRIMARY KEY(upload_id,offset));`);
  }
  lookup(id: string): UploadRecord | null {
    const row = this.store.db
      .prepare(
        `SELECT id,account_id AS accountId,chat_id AS chatId,
      name,mime_type AS mimeType,size,object_key AS key,sha256,status,received,
      expires_at AS expiresAt FROM staged_uploads WHERE id=?`,
      )
      .get(id);
    return (row as UploadRecord | undefined) ?? null;
  }
  get(id: string, accountId?: string, complete = false): UploadRecord {
    const row = this.lookup(id);
    if (!row || (accountId !== undefined && row.accountId !== accountId))
      throw new NotFoundError();
    if (row.status === 'deleting')
      throw new ConflictError(
        'UPLOAD_REMOVING',
        'This attachment is being removed. Attach it again.',
      );
    if (!row.chatId && row.expiresAt <= Date.now())
      throw new ApplicationError(
        410,
        'UPLOAD_EXPIRED',
        'This attachment expired. Attach it again.',
      );
    if (complete && row.status !== 'complete')
      throw new ConflictError(
        'UPLOAD_INCOMPLETE',
        'Wait for this attachment to finish uploading.',
      );
    return row;
  }
  reserve(row: UploadRecord): void {
    this.store.db.transaction(() => {
      const usage = this.store.db
        .prepare(
          'SELECT count(*) AS count,coalesce(sum(size),0) AS size FROM staged_uploads WHERE account_id=?',
        )
        .get(row.accountId) as { count: number; size: number };
      if (usage.count >= 200 || usage.size + row.size > 100 * 1024 * 1024)
        throw new ApplicationError(
          413,
          'UPLOAD_STORAGE_LIMIT',
          'Temporary attachment storage is full. Remove unused files or wait for queued work to finish.',
        );
      this.store.db
        .prepare('INSERT INTO staged_uploads VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          row.id,
          row.accountId,
          row.chatId,
          row.name,
          row.mimeType,
          row.size,
          row.key,
          row.sha256,
          row.status,
          row.received,
          row.expiresAt,
        );
    })();
  }
  chunks(id: string): UploadChunk[] {
    return this.store.db
      .prepare(
        'SELECT offset,size,sha256,object_key AS key FROM staged_upload_chunks WHERE upload_id=? ORDER BY offset',
      )
      .all(id) as UploadChunk[];
  }
  attachment(row: UploadRecord): Attachment {
    return {
      uploadId: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    };
  }
  retained(id: string): boolean {
    for (const chat of this.store.listChats()) {
      if (
        this.store
          .pending(chat.id)
          .some((item) => item.attachments.some((file) => file.uploadId === id))
      )
        return true;
      const input = this.store.metadata(chat.id).creationInput as {
        initialMessage?: { uploadIds?: string[] };
      } | null;
      if (
        (chat.status === 'creating' || chat.status === 'recovery') &&
        input?.initialMessage?.uploadIds?.includes(id)
      )
        return true;
    }
    return false;
  }
  pinnedKeys(): string[] {
    return (
      this.store.db
        .prepare(
          "SELECT object_key AS key FROM staged_uploads WHERE status='complete'",
        )
        .all() as { key: string }[]
    ).map((row) => row.key);
  }
}
