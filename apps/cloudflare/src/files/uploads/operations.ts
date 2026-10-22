import { decodeBase64, encodeBase64 } from './codec.js';
import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_FILE_BYTES,
  UNUSED_UPLOAD_LIFETIME_MS,
} from '@messenger/contracts';
import {
  ApplicationError,
  ConflictError,
  ValidationError,
} from '../../../../backend/src/errors.js';
import { safeFilename } from '../../../../backend/src/uploads/validation.js';
import { sha256 } from './objects.js';
import type { UploadRecord } from './types.js';
import type { UploadService } from './service.js';
export class UploadOperations {
  private completing = false;
  constructor(private readonly service: UploadService) {}
  begin(
    command: Extract<ManagerCommand, { type: 'upload.begin' }>,
    accountId: string,
  ): ManagerResultData {
    if (
      !Number.isSafeInteger(command.size) ||
      command.size <= 0 ||
      command.size > UPLOAD_FILE_BYTES
    )
      throw new ApplicationError(
        413,
        'UPLOAD_TOO_LARGE',
        'Each attachment must be at most five MiB.',
      );
    if (
      ![
        'image/png',
        'image/jpeg',
        'image/webp',
        'text/plain',
        'text/markdown',
        'application/pdf',
      ].includes(command.mimeType)
    )
      throw new ApplicationError(
        415,
        'UNSUPPORTED_ATTACHMENT',
        'Attach PNG, JPEG, WebP, UTF-8 text, Markdown, or PDF.',
      );
    const { db } = this.service.context.store;
    return db.transaction(() => {
      const previous = db
        .prepare(
          'SELECT account_id AS accountId,input,upload_id AS id FROM staged_upload_commands WHERE id=?',
        )
        .get(command.commandId) as
        { accountId: string; input: string; id: string } | undefined;
      if (previous) {
        if (
          previous.accountId !== accountId ||
          previous.input !== JSON.stringify(command)
        )
          throw new ConflictError(
            'COMMAND_ID_REUSED',
            'This command identity was already used with different values.',
          );
        const row = this.service.database.get(previous.id, accountId);
        return { uploadId: row.id, nextOffset: row.received };
      }
      const id = crypto.randomUUID();
      const row: UploadRecord = {
        id,
        accountId,
        chatId: null,
        name: safeFilename(command.name),
        mimeType: command.mimeType,
        size: command.size,
        key: `staging/uploads/${id}/content`,
        sha256: '',
        status: 'staging',
        received: 0,
        expiresAt: Date.now() + UNUSED_UPLOAD_LIFETIME_MS,
      };
      this.service.database.reserve(row);
      this.service.ownership.claim('upload', id, accountId);
      db.prepare('INSERT INTO staged_upload_commands VALUES (?,?,?,?)').run(
        command.commandId,
        accountId,
        JSON.stringify(command),
        id,
      );
      return { uploadId: id, nextOffset: 0 };
    })();
  }
  async chunk(
    row: UploadRecord,
    offset: number,
    encoded: string,
  ): Promise<ManagerResultData> {
    const bytes = decodeBase64(encoded);
    if (
      !bytes.length ||
      bytes.length > UPLOAD_CHUNK_BYTES ||
      encodeBase64(bytes) !== encoded ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + bytes.length > row.size
    )
      throw new ValidationError('Send a valid bounded attachment chunk.');
    const digest = await sha256(bytes);
    const previous = this.service.database
      .chunks(row.id)
      .find((chunk) => chunk.offset === offset);
    if (previous) {
      if (previous.size !== bytes.length || previous.sha256 !== digest)
        throw new ConflictError(
          'UPLOAD_CHUNK_CONFLICT',
          'This attachment chunk differs from the stored bytes. Attach the file again.',
        );
      return { uploadId: row.id, nextOffset: row.received };
    }
    if (row.status !== 'staging' || offset !== row.received)
      throw new ConflictError(
        'UPLOAD_OFFSET_MISMATCH',
        'Continue from the acknowledged attachment offset.',
      );
    const key = `staging/uploads/${row.id}/chunks/${offset}-${digest}`;
    const object = await this.service.objects.bucket.put(key, bytes, {
      sha256: digest,
    });
    if (!object || object.size !== bytes.length)
      throw new Error('Attachment chunk storage incomplete');
    this.service.context.store.db.transaction(() => {
      this.service.context.store.db
        .prepare('INSERT INTO staged_upload_chunks VALUES (?,?,?,?,?)')
        .run(row.id, offset, bytes.length, digest, key);
      this.service.context.store.db
        .prepare('UPDATE staged_uploads SET received=? WHERE id=?')
        .run(offset + bytes.length, row.id);
    })();
    return { uploadId: row.id, nextOffset: offset + bytes.length };
  }
  async complete(row: UploadRecord): Promise<ManagerResultData> {
    if (row.status === 'complete')
      return { upload: this.service.database.attachment(row) };
    if (row.received !== row.size)
      throw new ConflictError(
        'UPLOAD_INCOMPLETE',
        'Wait for this attachment to finish uploading.',
      );
    if (this.completing)
      throw new ConflictError(
        'UPLOAD_BUSY',
        'Wait for the current attachment to finish.',
      );
    this.completing = true;
    try {
      const digest = await this.service.objects.assemble(
        row,
        this.service.database.chunks(row.id),
      );
      this.service.context.store.db
        .prepare(
          "UPDATE staged_uploads SET status='complete',sha256=? WHERE id=?",
        )
        .run(digest, row.id);
      return { upload: this.service.database.attachment(row) };
    } finally {
      this.completing = false;
    }
  }
}
