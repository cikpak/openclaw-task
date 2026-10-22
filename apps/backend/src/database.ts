import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqlStore } from './storage/sql-store.js';
export type { ChatRecord, ChatMetadata } from './storage/store.js';

/** Local development and legacy Node deployment adapter. */
export class Store extends SqlStore {
  declare readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    super(db);
  }
}
