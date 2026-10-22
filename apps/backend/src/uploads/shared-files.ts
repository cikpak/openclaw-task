import type { Attachment, PendingMessage } from '@messenger/contracts';
import { z } from 'zod';
import type { SqlDatabase, Store } from '../storage/store.js';
import type { Gateway } from '../gateway/types.js';
import { GatewayUnavailableError, NotFoundError } from '../errors.js';
import { historyWithReceipts } from '../chats/history.js';
import { uploadResponseSchema } from './schemas.js';
import { backfillSharedFiles } from './shared-files-backfill.js';

export function initializeSharedFiles(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS shared_input_files (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL, upload_id TEXT NOT NULL, owner TEXT NOT NULL,
    run_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('private','confirmed')),
    json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(chat_id,message_id,upload_id));
    CREATE INDEX IF NOT EXISTS shared_input_files_chat ON shared_input_files(chat_id,created_at);`);
}
/** This ledger stores metadata only and never participates in temporary byte retention. */
export function trackInputFiles(db: SqlDatabase, item: PendingMessage): void {
  // Fake media providers need not own the real upload table.
  if (
    !db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='uploads'",
      )
      .get()
  )
    return;
  const ids = new Set(item.attachments.map((file) => file.uploadId));
  const previous = db
    .prepare(
      'SELECT upload_id FROM shared_input_files WHERE chat_id=? AND message_id=?',
    )
    .all(item.chatId, item.id);
  for (const row of previous) {
    const id = z.object({ upload_id: z.string() }).parse(row).upload_id;
    if (!ids.has(id))
      db.prepare(
        'DELETE FROM shared_input_files WHERE chat_id=? AND message_id=? AND upload_id=?',
      ).run(item.chatId, item.id, id);
  }
  for (const file of item.attachments) {
    const parsed = uploadResponseSchema.safeParse(file);
    if (!parsed.success) continue;
    const row = db
      .prepare('SELECT owner,name,mime_type,size FROM uploads WHERE id=?')
      .get(file.uploadId);
    if (!row) continue;
    const upload = z
      .object({
        owner: z.string(),
        name: z.string(),
        mime_type: z.string(),
        size: z.number(),
      })
      .parse(row);
    if (
      upload.name !== file.name ||
      upload.mime_type !== file.mimeType ||
      upload.size !== file.size
    )
      continue;
    db.prepare(
      `INSERT INTO shared_input_files VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(chat_id,message_id,upload_id) DO UPDATE SET run_id=excluded.run_id,
        state=CASE WHEN shared_input_files.state='confirmed' THEN 'confirmed' ELSE excluded.state END`,
    ).run(
      item.chatId,
      item.id,
      file.uploadId,
      upload.owner,
      item.submissionId,
      item.state === 'submitted' ? 'confirmed' : 'private',
      JSON.stringify(parsed.data),
      item.createdAt,
    );
  }
  db.prepare(
    `DELETE FROM shared_input_files WHERE chat_id=? AND rowid NOT IN
    (SELECT rowid FROM shared_input_files WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100)`,
  ).run(item.chatId, item.chatId);
}
export function removeInputFiles(
  db: SqlDatabase,
  item: PendingMessage,
  outcome: 'removed' | 'consumed' | 'cancelled',
): void {
  if (outcome === 'consumed')
    db.prepare(
      "UPDATE shared_input_files SET state='confirmed',run_id=? WHERE chat_id=? AND message_id=?",
    ).run(item.submissionId, item.chatId, item.id);
  else if (
    outcome === 'cancelled' ||
    item.state === 'pending' ||
    item.state === 'unknown' ||
    item.state === 'cancelled'
  )
    db.prepare(
      "DELETE FROM shared_input_files WHERE chat_id=? AND message_id=? AND state='private'",
    ).run(item.chatId, item.id);
}
const metadataRow = z.object({
  message_id: z.string(),
  run_id: z.string(),
  json: z.string(),
  state: z.enum(['private', 'confirmed']),
});
export async function sharedFiles(
  store: Store,
  gateway: Gateway,
  owner: string,
  chatId: string,
): Promise<Attachment[]> {
  const chat = store.getChat(chatId);
  if (chat.status === 'deleting') throw new NotFoundError();
  store.db.transaction(() => backfillSharedFiles(store, owner, chatId))();
  const rows = store.db
    .prepare(
      'SELECT message_id,run_id,json,state FROM shared_input_files WHERE chat_id=? AND owner=? ORDER BY created_at DESC,rowid DESC LIMIT 100',
    )
    .all(chatId, owner)
    .map((row) => metadataRow.parse(row));
  const pending = store.pending(chatId);
  const excluded = new Set(
    pending
      .filter(
        (item) =>
          item.state === 'pending' ||
          item.state === 'unknown' ||
          item.state === 'cancelled',
      )
      .map((item) => item.id),
  );
  const candidates = rows.filter(
    (row) => row.state === 'private' && !excluded.has(row.message_id),
  );
  if (gateway.ready && chat.agentId && chat.sessionKey && candidates.length) {
    const history = await historyWithReceipts(
      gateway,
      { agentId: chat.agentId, sessionKey: chat.sessionKey },
      [...new Set(candidates.map((row) => row.run_id))],
    ).catch((error: unknown) => {
      if (error instanceof GatewayUnavailableError) return null;
      throw error;
    });
    // A deletion/account-state change while the read yielded cannot expose retired metadata.
    if (store.getChat(chatId).status === 'deleting') throw new NotFoundError();
    for (const receipt of history?.receipts ?? []) {
      if (receipt.cancelled)
        store.db
          .prepare(
            "DELETE FROM shared_input_files WHERE chat_id=? AND owner=? AND run_id=? AND state='private'",
          )
          .run(chatId, owner, receipt.runId);
      else if (receipt.state === 'consumed' || receipt.state === 'pending')
        store.db
          .prepare(
            "UPDATE shared_input_files SET state='confirmed' WHERE chat_id=? AND owner=? AND run_id=?",
          )
          .run(chatId, owner, receipt.runId);
    }
  }
  const nowExcluded = new Set(
    store
      .pending(chatId)
      .filter(
        (item) =>
          item.state === 'pending' ||
          item.state === 'unknown' ||
          item.state === 'cancelled',
      )
      .map((item) => item.id),
  );
  return [
    ...new Map(
      store.db
        .prepare(
          "SELECT message_id,json FROM shared_input_files WHERE chat_id=? AND owner=? AND state='confirmed' ORDER BY created_at DESC,rowid DESC LIMIT 100",
        )
        .all(chatId, owner)
        .map((row) =>
          z.object({ message_id: z.string(), json: z.string() }).parse(row),
        )
        .filter((row) => !nowExcluded.has(row.message_id))
        .map((row) => uploadResponseSchema.parse(JSON.parse(row.json)))
        .map((file) => [file.uploadId, file]),
    ).values(),
  ];
}
