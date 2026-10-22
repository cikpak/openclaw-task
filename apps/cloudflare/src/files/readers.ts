import type { Store } from '../../../backend/src/storage/store.js';
import { GatewayUnavailableError } from '../../../backend/src/errors.js';
const LEASE_MS = 90_000;
/** Durable pins survive manager reconstruction; stalled transfers time out independently of auth. */
export class FileReaders {
  constructor(
    private readonly store: Store,
    private readonly changed: () => void = () => {},
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS file_readers (id TEXT PRIMARY KEY, object_key TEXT, live INTEGER NOT NULL, expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS file_deletions (object_key TEXT PRIMARY KEY)',
    );
  }
  admit(live: boolean, key: string | null): string {
    if (key && this.deleting(key)) throw new GatewayUnavailableError();
    const id = crypto.randomUUID();
    this.store.db
      .prepare('INSERT INTO file_readers VALUES (?, ?, ?, ?)')
      .run(id, key, live ? 1 : 0, Date.now() + 180_000);
    this.changed();
    return id;
  }
  deleting(key: string): boolean {
    return !!this.store.db
      .prepare('SELECT object_key FROM file_deletions WHERE object_key = ?')
      .get(key);
  }
  release(id: string): void {
    this.store.db.prepare('DELETE FROM file_readers WHERE id = ?').run(id);
    this.changed();
  }
  prune(): void {
    this.store.db
      .prepare('DELETE FROM file_readers WHERE expires_at <= ?')
      .run(Date.now());
  }
  live(): boolean {
    this.prune();
    return !!this.store.db
      .prepare('SELECT id FROM file_readers WHERE live = 1 LIMIT 1')
      .get();
  }
  keys(): Set<string> {
    this.prune();
    return new Set(
      (
        this.store.db
          .prepare(
            'SELECT object_key FROM file_readers WHERE object_key IS NOT NULL',
          )
          .all() as { object_key: string }[]
      ).map((row) => row.object_key),
    );
  }
  beginDelete(key: string): boolean {
    this.prune();
    if (this.keys().has(key)) return false;
    this.store.db
      .prepare('INSERT OR IGNORE INTO file_deletions VALUES (?)')
      .run(key);
    return true;
  }
  endDelete(key: string): void {
    this.store.db
      .prepare('DELETE FROM file_deletions WHERE object_key = ?')
      .run(key);
  }
  stream(
    body: ReadableStream<Uint8Array>,
    id: string,
  ): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let ended = false;
    let deadline = Date.now() + LEASE_MS;
    this.store.db
      .prepare('UPDATE file_readers SET expires_at = ? WHERE id = ?')
      .run(deadline, id);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      this.release(id);
    };
    const timer = setInterval(() => {
      if (Date.now() < deadline) return;
      finish();
      void reader.cancel().catch(() => {});
      controller.error(new Error('File transfer timed out.'));
    }, 1000);
    return new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull: async (target) => {
          try {
            const part = await reader.read();
            if (ended) return;
            if (part.done) {
              finish();
              target.close();
              return;
            }
            deadline = Date.now() + LEASE_MS;
            this.store.db
              .prepare('UPDATE file_readers SET expires_at = ? WHERE id = ?')
              .run(deadline, id);
            target.enqueue(part.value);
          } catch (error) {
            finish();
            target.error(error);
          }
        },
        cancel: async (reason) => {
          finish();
          await reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    );
  }
}
