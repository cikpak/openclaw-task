import { SqlStore } from './sql-store.js';
import type { SqlDatabase, SqlStatement } from './store.js';

/** Minimal structural surface accepted from DurableObjectState.storage. */
export interface DurableSqlStorage {
  sql: {
    exec(
      query: string,
      ...bindings: unknown[]
    ): Iterable<Record<string, unknown>>;
  };
  transactionSync<T>(work: () => T): T;
}

/** Adapt Cloudflare's synchronous SQLite cursor to the domain's SQL boundary. */
export class DurableSqlDatabase implements SqlDatabase {
  constructor(private readonly storage: DurableSqlStorage) {}
  prepare(query: string): SqlStatement {
    return {
      get: (...bindings) => {
        for (const row of this.storage.sql.exec(query, ...bindings)) return row;
        return undefined;
      },
      all: (...bindings) => [...this.storage.sql.exec(query, ...bindings)],
      run: (...bindings) => {
        // Exhaust the cursor so every statement is completed before returning.
        for (const row of this.storage.sql.exec(query, ...bindings)) void row;
      },
    };
  }
  exec(query: string): void {
    for (const row of this.storage.sql.exec(query)) void row;
  }
  transaction<T>(work: () => T): () => T {
    // Native nested transactions provide savepoint rollback semantics; issuing
    // SQL SAVEPOINT/BEGIN directly is prohibited by Durable Object SQLite.
    return () => this.storage.transactionSync(work);
  }
  close(): void {
    // Durable Object storage lifetime belongs to the runtime.
  }
}

/** Does not open sockets, wake a container, or depend on Node built-ins. */
export class DurableObjectStore extends SqlStore {
  constructor(storage: DurableSqlStorage) {
    super(new DurableSqlDatabase(storage));
  }
}
