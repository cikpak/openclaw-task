import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Attachment, ChatSettings } from '@messenger/contracts';
import type { Store } from '../database.js';
import type {
  Gateway,
  GatewayAttachment,
  GatewayMapping,
} from '../gateway/types.js';
import { ApplicationError, ConflictError, NotFoundError } from '../errors.js';
import {
  DEFAULT_GATEWAY_PAYLOAD,
  safeFilename,
  UPLOAD_LIFETIME,
  validateFile,
  validateMessageSize,
} from './validation.js';

const rowSchema = z.object({
  id: z.uuid(),
  owner: z.string(),
  name: z.string(),
  mime_type: z.string(),
  size: z.number().int().positive(),
  expires_at: z.number(),
});
type UploadRow = z.infer<typeof rowSchema>;
function attachment(row: UploadRow): Attachment {
  return {
    uploadId: row.id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
  };
}

/** Files have opaque UUID paths; only the configured account owns them, independently of login sessions. */
export class UploadService {
  private readonly directory: string;
  private readonly preparing = new Map<string, number>();
  private readonly deleting = new Set<string>();
  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly owner: string,
    private readonly gateway: Gateway,
  ) {
    this.directory = join(dataDir, 'uploads');
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    );
  }
  accountOwner(): string {
    return this.owner;
  }
  async create(bytes: Buffer, mime: string, name: string): Promise<Attachment> {
    const validatedMime = validateFile(bytes, mime);
    await this.cleanup();
    const usage = z
      .object({ count: z.number(), size: z.number() })
      .parse(
        this.store.db
          .prepare(
            'SELECT count(*) AS count, coalesce(sum(size), 0) AS size FROM uploads WHERE owner = ?',
          )
          .get(this.owner),
      );
    if (usage.count >= 200 || usage.size + bytes.length > 100 * 1024 * 1024)
      throw new ApplicationError(
        413,
        'UPLOAD_STORAGE_LIMIT',
        'Temporary attachment storage is full. Remove unused files or wait for queued work to finish.',
      );
    const row: UploadRow = {
      id: randomUUID(),
      owner: this.owner,
      name: safeFilename(name),
      mime_type: validatedMime,
      size: bytes.length,
      expires_at: Date.now() + UPLOAD_LIFETIME,
    };
    // Reserve storage synchronously before yielding so simultaneous requests cannot bypass the quota.
    this.store.db
      .prepare('INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        row.id,
        row.owner,
        row.name,
        row.mime_type,
        row.size,
        row.expires_at,
      );
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, row.id), bytes, {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      this.store.db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
      throw error;
    }
    return attachment(row);
  }
  private get(id: string, allowRetained = false): UploadRow {
    if (!z.uuid().safeParse(id).success) throw new NotFoundError();
    if (this.deleting.has(id))
      throw new ConflictError(
        'UPLOAD_REMOVING',
        'This attachment is being removed. Attach the file again.',
      );
    const raw = this.store.db
      .prepare('SELECT * FROM uploads WHERE id = ? AND owner = ?')
      .get(id, this.owner);
    if (!raw) throw new NotFoundError();
    const row = rowSchema.parse(raw);
    if (
      row.expires_at <= Date.now() &&
      !(allowRetained && this.retainedIds().has(id))
    )
      throw new ApplicationError(
        410,
        'UPLOAD_EXPIRED',
        'This attachment expired. Attach the file again.',
      );
    return row;
  }
  async prepare(
    settings: ChatSettings,
    ids: string[],
    mapping?: GatewayMapping,
  ): Promise<Attachment[]> {
    if (new Set(ids).size !== ids.length)
      throw new ApplicationError(
        400,
        'DUPLICATE_ATTACHMENT',
        'Attach each file only once per message.',
      );
    const rows = ids.map((id) => this.get(id, true));
    validateMessageSize(
      rows.map((row) => row.size),
      this.gateway.maxPayload ?? DEFAULT_GATEWAY_PAYLOAD,
    );
    for (const row of rows)
      this.preparing.set(row.id, (this.preparing.get(row.id) ?? 0) + 1);
    try {
      if (rows.length) {
        const catalog = this.gateway.ready
          ? await this.gateway.models(mapping)
          : mapping
            ? this.gateway.cachedModels?.(mapping)
            : null;
        if (!catalog)
          throw new ApplicationError(
            503,
            'ATTACHMENT_CAPABILITIES_UNAVAILABLE',
            'Attachment compatibility is unavailable while OpenClaw reconnects. Keep the files attached and try again when it is ready.',
          );
        const model = catalog.find(
          (item) => item.id === settings.model && item.available,
        );
        if (
          !model ||
          rows.some(
            (row) =>
              !model.input.includes(
                row.mime_type.startsWith('image/') ? 'image' : 'text',
              ),
          )
        )
          throw new ApplicationError(
            422,
            'ATTACHMENT_MODEL_INCOMPATIBLE',
            'The selected model cannot consume these attachments. Choose a compatible model or remove the files.',
          );
      }
      return rows.map(attachment);
    } finally {
      // All callers durably persist their references synchronously in the await continuation.
      // Keep admission fenced through those microtasks; the next event-loop turn can release it.
      setImmediate(() => {
        for (const row of rows) {
          const count = (this.preparing.get(row.id) ?? 1) - 1;
          if (count) this.preparing.set(row.id, count);
          else this.preparing.delete(row.id);
        }
      });
    }
  }
  async payload(
    attachments: Attachment[],
    settings?: ChatSettings,
    mapping?: GatewayMapping,
  ): Promise<GatewayAttachment[]> {
    const rows = attachments.map((item) => this.get(item.uploadId, true));
    if (settings && mapping && rows.length) {
      // Admission may use the verified offline cache; delivery always refreshes it.
      const model = (await this.gateway.models(mapping)).find(
        (entry) => entry.id === settings.model && entry.available,
      );
      if (
        !model ||
        rows.some(
          (row) =>
            !model.input.includes(
              row.mime_type.startsWith('image/') ? 'image' : 'text',
            ),
        )
      )
        throw new ApplicationError(
          422,
          'ATTACHMENT_MODEL_INCOMPATIBLE',
          'These queued attachments no longer match the selected model. Edit or cancel the queued message before continuing.',
        );
    }
    validateMessageSize(
      rows.map((row) => row.size),
      this.gateway.maxPayload ?? DEFAULT_GATEWAY_PAYLOAD,
    );
    return Promise.all(
      rows.map(async (row) => {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(this.directory, row.id));
        } catch {
          throw new ApplicationError(
            410,
            'UPLOAD_UNAVAILABLE',
            'An attachment is unavailable. Attach it again before retrying.',
          );
        }
        if (bytes.length !== row.size)
          throw new ApplicationError(
            410,
            'UPLOAD_UNAVAILABLE',
            'An attachment is unavailable. Attach it again before retrying.',
          );
        validateFile(bytes, row.mime_type);
        return {
          type: row.mime_type.startsWith('image/') ? 'image' : 'file',
          mimeType: row.mime_type,
          fileName: row.name,
          content: bytes.toString('base64'),
          sizeBytes: row.size,
          origin: 'file',
        };
      }),
    );
  }
  private retainedIds(): Set<string> {
    const ids = new Set<string>();
    for (const chat of this.store.listChats()) {
      for (const item of this.store.pending(chat.id))
        for (const file of item.attachments) ids.add(file.uploadId);
      if (
        !chat.agentId &&
        (chat.status === 'creating' || chat.status === 'recovery')
      ) {
        const input = z
          .object({
            initialMessage: z
              .object({ uploadIds: z.array(z.string()).optional() })
              .optional(),
          })
          .safeParse(this.store.metadata(chat.id).creationInput);
        for (const id of input.success
          ? (input.data.initialMessage?.uploadIds ?? [])
          : [])
          ids.add(id);
      }
    }
    return ids;
  }
  async remove(id: string): Promise<void> {
    const row = this.get(id, true);
    if (this.retainedIds().has(row.id) || this.preparing.has(row.id))
      throw new ConflictError(
        'UPLOAD_IN_USE',
        'This attachment belongs to accepted work and cannot be removed yet.',
      );
    await this.erase(row.id);
  }
  private async erase(id: string): Promise<void> {
    if (
      this.preparing.has(id) ||
      this.deleting.has(id) ||
      this.retainedIds().has(id)
    )
      return;
    this.deleting.add(id);
    try {
      try {
        await unlink(join(this.directory, id));
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
      this.store.db
        .prepare('DELETE FROM uploads WHERE id = ? AND owner = ?')
        .run(id, this.owner);
    } finally {
      this.deleting.delete(id);
    }
  }
  async cleanup(): Promise<void> {
    const retained = this.retainedIds();
    const rows = this.store.db
      .prepare('SELECT * FROM uploads WHERE owner = ? AND expires_at <= ?')
      .all(this.owner, Date.now())
      .map((raw) => rowSchema.parse(raw));
    for (const row of rows) if (!retained.has(row.id)) await this.erase(row.id);
  }
}
