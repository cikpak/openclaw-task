import { z } from 'zod';
import type { Store } from '../storage/store.js';
import { commandSchema, resultSchema } from '../schemas.js';
import { uploadResponseSchema } from './schemas.js';

function json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
/** Only exact successful send identities are recoverable; creation input has no durable submission association. */
export function backfillSharedFiles(
  store: Store,
  owner: string,
  chatId: string,
): void {
  const rows = store.db
    .prepare(
      `SELECT q.json AS request,r.json AS result,r.created_at FROM command_requests q JOIN command_results r ON r.id=q.id
    WHERE CASE WHEN json_valid(q.json) THEN json_extract(q.json,'$.chatId') END=?
      AND CASE WHEN json_valid(q.json) THEN json_extract(q.json,'$.type') END='conversation.message.send'
    ORDER BY r.created_at DESC,r.rowid DESC LIMIT 100`,
    )
    .all(chatId);
  for (const raw of rows) {
    const row = z
      .object({
        request: z.string(),
        result: z.string(),
        created_at: z.number(),
      })
      .parse(raw);
    const command = commandSchema.safeParse(json(row.request));
    const result = resultSchema.safeParse(json(row.result));
    if (
      !command.success ||
      command.data.type !== 'conversation.message.send' ||
      !result.success ||
      !result.data.ok ||
      result.data.commandId !== command.data.commandId ||
      result.data.data.messageId !== command.data.commandId
    )
      continue;
    const request = command.data;
    if (
      store.db
        .prepare(
          'SELECT 1 FROM shared_input_files WHERE chat_id=? AND message_id=? LIMIT 1',
        )
        .get(chatId, request.commandId)
    )
      continue;
    const active = store
      .pending(chatId)
      .find((item) => item.id === request.commandId);
    let ids = request.uploadIds ?? [];
    let discarded = false;
    const mutations = store.db
      .prepare(
        `SELECT q.json AS request,r.json AS result FROM command_requests q JOIN command_results r ON r.id=q.id
      WHERE CASE WHEN json_valid(q.json) THEN json_extract(q.json,'$.chatId') END=?
        AND CASE WHEN json_valid(q.json) THEN json_extract(q.json,'$.messageId') END=? ORDER BY r.created_at,r.rowid LIMIT 101`,
      )
      .all(chatId, request.commandId);
    // Too many mutations to inspect safely: do not guess effective attachments.
    if (mutations.length > 100) continue;
    for (const mutationRaw of mutations) {
      const mutation = z
        .object({ request: z.string(), result: z.string() })
        .parse(mutationRaw);
      const edit = commandSchema.safeParse(json(mutation.request));
      const acknowledged = resultSchema.safeParse(json(mutation.result));
      if (
        !edit.success ||
        !acknowledged.success ||
        !acknowledged.data.ok ||
        acknowledged.data.commandId !== edit.data.commandId
      )
        continue;
      if (
        (edit.data.type === 'conversation.message.editQueued' ||
          edit.data.type === 'conversation.message.cancelQueued') &&
        acknowledged.data.data.messageId !== request.commandId
      )
        continue;
      if (
        edit.data.type === 'conversation.message.cancelQueued' ||
        (edit.data.type === 'conversation.message.resolveUnknown' &&
          edit.data.action === 'discard')
      )
        discarded = true;
      if (
        edit.data.type === 'conversation.message.editQueued' &&
        edit.data.uploadIds !== undefined
      )
        ids = edit.data.uploadIds;
    }
    if (discarded) continue;
    if (active) ids = active.attachments.map((file) => file.uploadId);
    for (const id of ids) {
      const rawUpload = store.db
        .prepare(
          'SELECT id,name,mime_type,size FROM uploads WHERE id=? AND owner=? AND expires_at>?',
        )
        .get(id, owner, Date.now());
      if (!rawUpload) continue;
      const upload = z
        .object({
          id: z.string(),
          name: z.string(),
          mime_type: z.string(),
          size: z.number(),
        })
        .parse(rawUpload);
      const file = uploadResponseSchema.safeParse({
        uploadId: upload.id,
        name: upload.name,
        mimeType: upload.mime_type,
        size: upload.size,
      });
      if (!file.success) continue;
      const runId = active?.submissionId ?? request.commandId;
      store.db
        .prepare(
          'INSERT OR IGNORE INTO shared_input_files VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          chatId,
          request.commandId,
          id,
          owner,
          runId,
          'private',
          JSON.stringify(file.data),
          row.created_at,
        );
    }
  }
  store.db
    .prepare(
      `DELETE FROM shared_input_files WHERE chat_id=? AND rowid NOT IN (SELECT rowid FROM shared_input_files WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100)`,
    )
    .run(chatId, chatId);
}
