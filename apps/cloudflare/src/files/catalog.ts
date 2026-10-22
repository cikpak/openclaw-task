import type { BrowserFile } from '@messenger/contracts';
import type { Store } from '../../../backend/src/storage/store.js';
import {
  BrowserProjection,
  type ProjectionPolicy,
} from '../../../backend/src/presentation/safe.js';
import { NotFoundError } from '../../../backend/src/errors.js';
import type { ManagerAuthorization } from '../manager/authorization.js';
import type { RecoveryDescriptor } from '../engine/recovery/types.js';

export interface FilePublicationInput {
  sessionKey: string;
  agentId: string;
  path: string;
  documentsRoot: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: number;
  digest?: string;
}
export interface CatalogFile {
  file: BrowserFile;
  accountId: string;
  chatId: string;
  agentId: string;
  sessionKey: string;
  path: string;
  documentsRoot: string;
  objectKey: string | null;
  deleted: boolean;
  digest?: string;
}
/** Only a verified native publication can create a browser-visible deliverable. */
export class FileCatalog {
  constructor(
    private readonly store: Store,
    private readonly auth: ManagerAuthorization,
  ) {
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS browser_files (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
    );
  }
  all(): CatalogFile[] {
    return (
      this.store.db.prepare('SELECT json FROM browser_files').all() as {
        json: string;
      }[]
    ).map((row) => JSON.parse(row.json) as CatalogFile);
  }
  get(id: string): CatalogFile {
    const row = this.store.db
      .prepare('SELECT json FROM browser_files WHERE id = ?')
      .get(id) as { json: string } | undefined;
    if (!row) throw new NotFoundError();
    const record = JSON.parse(row.json) as CatalogFile;
    if (record.deleted) throw new NotFoundError();
    return record;
  }
  records(): { agentId: string; sessionKey: string; path: string }[] {
    return this.all()
      .filter((record) => !record.deleted)
      .map(({ agentId, sessionKey, path }) => ({ agentId, sessionKey, path }));
  }
  revoke(
    mapping: { agentId: string; sessionKey: string },
    path: string,
  ): Promise<void> {
    for (const record of this.all())
      if (
        record.agentId === mapping.agentId &&
        record.sessionKey === mapping.sessionKey &&
        (record.path === path ||
          (!path.startsWith('/') && record.path.endsWith('/' + path)))
      )
        this.save({ ...record, deleted: true });
    return Promise.resolve();
  }
  policy(sessionKey?: string): ProjectionPolicy {
    const records = this.all().filter(
      (record) =>
        !record.deleted &&
        (sessionKey === undefined || record.sessionKey === sessionKey),
    );
    return {
      documentsRoots: [
        ...new Set(records.map((record) => record.documentsRoot)),
      ],
      publications: records.map((record) => ({
        nativePath: record.path,
        classification: 'deliverable',
        file: record.file,
        ...(sessionKey === undefined
          ? {}
          : {
              relativePath:
                'documents/' +
                record.path.slice(
                  record.documentsRoot.replace(/\/$/, '').length + 1,
                ),
            }),
      })),
    };
  }
  publish(input: FilePublicationInput): Promise<BrowserFile> {
    const chat = this.store
      .listChats()
      .find(
        (candidate) =>
          candidate.agentId === input.agentId &&
          candidate.sessionKey === input.sessionKey,
      );
    if (!chat) throw new NotFoundError();
    const owner = this.store.db
      .prepare(
        "SELECT account_id FROM manager_resources WHERE kind = 'chat' AND id = ?",
      )
      .get(chat.id) as { account_id: string } | undefined;
    if (!owner) throw new NotFoundError();
    const previous = this.all().find(
      (record) => record.chatId === chat.id && record.path === input.path,
    );
    const file: BrowserFile = {
      id: previous?.file.id ?? crypto.randomUUID(),
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.size,
      category: 'deliverable',
      updatedAt: input.modifiedAt,
    };
    if (
      !new BrowserProjection({
        documentsRoots: [input.documentsRoot],
        publications: [
          { nativePath: input.path, classification: 'deliverable', file },
        ],
      }).file(input.path)
    )
      throw new NotFoundError();
    const record: CatalogFile = {
      file,
      accountId: owner.account_id,
      chatId: chat.id,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      path: input.path,
      documentsRoot: input.documentsRoot,
      objectKey: previous?.objectKey ?? null,
      deleted: false,
      ...(input.digest ? { digest: input.digest } : {}),
    };
    this.store.db.transaction(() => {
      this.auth.claim('file', file.id, owner.account_id, chat.id);
      this.save(record);
    })();
    return Promise.resolve(file);
  }
  list(chatId: string, accountId: string): BrowserFile[] {
    return this.all()
      .filter(
        (record) =>
          !record.deleted &&
          record.chatId === chatId &&
          record.accountId === accountId,
      )
      .map((record) => record.file);
  }
  save(record: CatalogFile): void {
    this.store.db
      .prepare(
        'INSERT INTO browser_files VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      )
      .run(record.file.id, JSON.stringify(record));
  }
  /** Runs inside the coherent checkpoint transaction; absence records deletion. */
  commit(descriptor: RecoveryDescriptor): void {
    for (const record of this.all()) {
      const source = descriptor.files.find(
        (file) =>
          file.path === record.path || `/recovery/${file.path}` === record.path,
      );
      const eligible =
        !record.deleted && source && record.digest === source.sha256;
      this.save({
        ...record,
        objectKey: eligible ? source.key : null,
        deleted: !eligible,
      });
    }
  }
  pinnedKeys(): string[] {
    return this.all()
      .filter((record) => !record.deleted && record.objectKey)
      .map((record) => record.objectKey!);
  }
}
