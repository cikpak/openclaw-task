import type { Store } from '../../../backend/src/storage/store.js';
import type { GatewayMapping } from '../../../backend/src/gateway/types.js';
import type { RecoveryDescriptor } from '../engine/recovery/types.js';
import type { UploadService } from './uploads/service.js';
export interface InputAudit {
  digest: string;
  size: number;
  modifiedAt: number;
}
/** Preservation and browser eligibility are independent, including for changed input files. */
export class InputPublications {
  constructor(
    private readonly store: Store,
    private readonly uploads: UploadService,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS input_publications(id TEXT PRIMARY KEY,json TEXT NOT NULL)',
    );
  }
  get(id: string): (InputAudit & { eligible: boolean }) | null {
    const row = this.store.db
      .prepare('SELECT json FROM input_publications WHERE id = ?')
      .get(id) as { json: string } | undefined;
    return row
      ? (JSON.parse(row.json) as InputAudit & { eligible: boolean })
      : null;
  }
  private save(id: string, value: InputAudit & { eligible: boolean }): void {
    this.store.db
      .prepare(
        'INSERT INTO input_publications VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
      )
      .run(id, JSON.stringify(value));
  }
  async audit(
    metadata: (mapping: GatewayMapping, id: string) => Promise<InputAudit>,
  ): Promise<void> {
    for (const { id } of this.store.db
      .prepare('SELECT id FROM input_file_paths')
      .all() as { id: string }[]) {
      const row = this.uploads.lookup(id);
      if (!row?.chatId) continue;
      const chat = this.store
        .listChats()
        .find((chat) => chat.id === row.chatId);
      if (!chat?.agentId || !chat.sessionKey) continue;
      // Disable publication before asynchronous inspection; unsafe current bytes must not fall back.
      this.save(id, { digest: '', size: 0, modifiedAt: 0, eligible: false });
      try {
        const checked = await metadata(
          { agentId: chat.agentId, sessionKey: chat.sessionKey },
          id,
        );
        if (!/^[a-f0-9]{64}$/.test(checked.digest))
          throw new Error('File audit failed');
        this.save(id, { ...checked, eligible: true });
      } catch {
        /* Meaningful bytes still belong in recovery, privately. */
      }
    }
  }
  commit(descriptor: RecoveryDescriptor): void {
    for (const row of this.store.db
      .prepare('SELECT id,path FROM input_file_paths')
      .all() as { id: string; path: string }[]) {
      const source = descriptor.files.find(
        (file) =>
          file.path === row.path || `/recovery/${file.path}` === row.path,
      );
      const audit = this.get(row.id);
      const eligible =
        audit?.eligible === true && audit.digest === source?.sha256;
      this.store.db
        .prepare('UPDATE input_file_paths SET object_key = ? WHERE id = ?')
        .run(eligible ? source.key : null, row.id);
      if (!eligible)
        this.save(row.id, {
          digest: '',
          size: 0,
          modifiedAt: 0,
          eligible: false,
        });
    }
  }
}
