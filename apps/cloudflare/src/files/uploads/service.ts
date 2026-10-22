import type {
  Attachment,
  ManagerCommand,
  ManagerResultData,
} from '@messenger/contracts';
import {
  ConflictError,
  ValidationError,
} from '../../../../backend/src/errors.js';
import { validateMessageSize } from '../../../../backend/src/uploads/validation.js';
import type { EngineContext } from '../../manager/types.js';
import { UploadDatabase } from './database.js';
import { UploadObjects } from './objects.js';
import { managerSecrets } from '../secrets.js';
import { UploadOperations } from './operations.js';
import type { UploadOwnership, UploadRecord } from './types.js';

export function commandUploadIds(command: ManagerCommand): string[] {
  return command.type === 'chat.create'
    ? (command.initialMessage?.uploadIds ?? [])
    : 'uploadIds' in command
      ? (command.uploadIds ?? [])
      : [];
}
export class UploadService {
  readonly database: UploadDatabase;
  readonly objects: UploadObjects;
  private readonly active = new Map<
    string,
    { tail: Promise<unknown>; count: number }
  >();
  private readonly operations: UploadOperations;
  constructor(
    readonly context: EngineContext,
    readonly ownership: UploadOwnership,
    private readonly canDelete: (row: UploadRecord) => boolean = () => true,
  ) {
    this.database = new UploadDatabase(context.store);
    this.operations = new UploadOperations(this);
    this.objects = new UploadObjects(context.env, () =>
      managerSecrets(context),
    );
    context.store.db.exec(
      'CREATE TABLE IF NOT EXISTS staged_upload_commands (id TEXT PRIMARY KEY,account_id TEXT NOT NULL,input TEXT NOT NULL,upload_id TEXT NOT NULL)',
    );
  }
  lookup(id: string): UploadRecord | null {
    return this.database.lookup(id);
  }
  pinnedKeys(): string[] {
    return this.database.pinnedKeys();
  }
  deadline(): number | null {
    const row = this.context.store.db
      .prepare(
        "SELECT min(expires_at) AS deadline FROM staged_uploads WHERE chat_id IS NULL OR status='deleting'",
      )
      .get() as { deadline: number | null };
    return row.deadline;
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.active.get(id);
    if (previous && previous.count >= 2)
      throw new ConflictError(
        'UPLOAD_BUSY',
        'Wait for the current attachment chunk to finish.',
      );
    const record = previous ?? { tail: Promise.resolve(), count: 0 };
    record.count++;
    this.active.set(id, record);
    const result = record.tail.catch(() => {}).then(work);
    record.tail = result;
    try {
      return await result;
    } finally {
      if (--record.count === 0) this.active.delete(id);
    }
  }
  async handle(
    command: ManagerCommand,
    accountId: string,
  ): Promise<ManagerResultData | undefined> {
    if (command.type === 'upload.begin')
      return this.operations.begin(command, accountId);
    if (!('uploadId' in command) || !command.type.startsWith('upload.'))
      return undefined;
    this.ownership.require('upload', command.uploadId, accountId);
    return this.exclusive(command.uploadId, async () => {
      const row = this.database.get(command.uploadId, accountId);
      if (command.type === 'upload.chunk')
        return this.operations.chunk(row, command.offset, command.base64);
      if (command.type === 'upload.complete')
        return this.operations.complete(row);
      if (command.type === 'upload.remove') {
        if (row.chatId || this.database.retained(row.id))
          throw new ConflictError(
            'UPLOAD_IN_USE',
            'This attachment belongs to accepted work and cannot be removed.',
          );
        await this.erase(row);
        return {};
      }
      return undefined;
    });
  }
  prepare(command: ManagerCommand, accountId: string): Promise<Attachment[]> {
    return Promise.resolve().then(() =>
      this.prepareIds(
        commandUploadIds(command),
        accountId,
        'chatId' in command
          ? command.chatId
          : command.type === 'chat.create'
            ? this.context.store.creationCommand(command.commandId)?.chatId
            : undefined,
      ),
    );
  }
  prepareIds(ids: string[], accountId?: string, chatId?: string): Attachment[] {
    if (new Set(ids).size !== ids.length)
      throw new ValidationError('Attach each file only once per message.');
    const rows = ids.map((id) => {
      const row = this.database.get(id, accountId, true);
      if (row.chatId && row.chatId !== chatId)
        throw new ConflictError(
          'UPLOAD_IN_USE',
          'This attachment belongs to another chat. Attach it again.',
        );
      return row;
    });
    validateMessageSize(rows.map((row) => row.size));
    return rows.map((row) => this.database.attachment(row));
  }
  /** Call inside the same transaction as durable acceptance; no I/O or wake. */
  commitReferences(
    command: ManagerCommand,
    chatId: string,
    accountId: string,
  ): void {
    const ids = commandUploadIds(command);
    this.prepareIds(ids, accountId, chatId);
    for (const id of ids) {
      this.context.store.db
        .prepare('UPDATE staged_uploads SET chat_id=? WHERE id=?')
        .run(chatId, id);
      this.ownership.claim('file', id, accountId, chatId);
    }
  }
  private async erase(row: UploadRecord): Promise<void> {
    if (this.database.retained(row.id) || !this.canDelete(row)) return;
    this.context.store.db
      .prepare("UPDATE staged_uploads SET status='deleting' WHERE id=?")
      .run(row.id);
    let cursor: string | undefined;
    do {
      const page = await this.objects.bucket.list({
        prefix: `staging/uploads/${row.id}/`,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects)
        await this.objects.bucket.delete(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.context.store.db.transaction(() => {
      this.context.store.db
        .prepare('DELETE FROM staged_upload_chunks WHERE upload_id=?')
        .run(row.id);
      this.context.store.db
        .prepare('DELETE FROM staged_uploads WHERE id=?')
        .run(row.id);
    })();
  }
  async cleanup(): Promise<void> {
    const chats = new Set(
      this.context.store.listChats().map((chat) => chat.id),
    );
    const rows = this.context.store.db
      .prepare(
        "SELECT id FROM staged_uploads WHERE status='deleting' OR expires_at<=? OR chat_id IS NOT NULL",
      )
      .all(Date.now()) as { id: string }[];
    for (const { id } of rows) {
      if (this.active.has(id)) continue;
      const row = this.lookup(id);
      if (
        !row ||
        (row.chatId && chats.has(row.chatId)) ||
        this.database.retained(id)
      )
        continue;
      await this.exclusive(id, () => this.erase(row));
    }
  }
}
