import type { SqlDatabase } from './store.js';
import { initializeSharedFiles } from '../uploads/shared-files.js';

export function initializeStore(db: SqlDatabase): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, json TEXT NOT NULL, agent_id TEXT UNIQUE, session_key TEXT UNIQUE, creation_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_results (id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(chat_id, position));
      CREATE TABLE IF NOT EXISTS pending_steer_intents (message_id TEXT PRIMARY KEY REFERENCES pending_messages(id) ON DELETE CASCADE, revision INTEGER NOT NULL, target_run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings_operations (chat_id TEXT PRIMARY KEY REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_metadata (chat_id TEXT PRIMARY KEY REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_requests (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_history (chat_id TEXT PRIMARY KEY REFERENCES chats(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_scopes (message_id TEXT PRIMARY KEY REFERENCES pending_messages(id) ON DELETE CASCADE, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_cancellations (message_id TEXT PRIMARY KEY REFERENCES pending_messages(id) ON DELETE CASCADE, revision INTEGER NOT NULL, submission_id TEXT NOT NULL, session_id TEXT NOT NULL, owner_run_id TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pending_abort_requests (message_id TEXT PRIMARY KEY REFERENCES pending_messages(id) ON DELETE CASCADE, request_id TEXT UNIQUE NOT NULL, revision INTEGER NOT NULL, submission_id TEXT NOT NULL, session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_input_cancellations (request_id TEXT PRIMARY KEY REFERENCES pending_abort_requests(request_id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind = 'pre-execution-input-cancelled'), input_id TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_abort_receipts (request_id TEXT NOT NULL REFERENCES pending_abort_requests(request_id) ON DELETE CASCADE, run_id TEXT NOT NULL, PRIMARY KEY(request_id,run_id));
      CREATE TABLE IF NOT EXISTS creation_commands (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, json TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS deletion_tombstones (chat_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_tools (chat_id TEXT NOT NULL REFERENCES chats(id), id TEXT NOT NULL, sequence INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(chat_id, id));
      INSERT OR IGNORE INTO creation_commands (id, chat_id, json) SELECT creation_id, id, 'null' FROM chats;
      INSERT OR IGNORE INTO migrations VALUES (1, unixepoch() * 1000);
      INSERT OR IGNORE INTO migrations VALUES (2, unixepoch() * 1000);
    `);
  initializeSharedFiles(db);
  if (!db.prepare('SELECT version FROM migrations WHERE version = 3').get()) {
    db.transaction(() => {
      // Drop only observations. Never expire mutation identities or uncertain receipts.
      db.exec(`
          DELETE FROM command_results WHERE id IN (
            SELECT id FROM command_requests WHERE
              CASE WHEN json_valid(json) THEN json_extract(json, '$.type') END
                IN ('conversation.snapshot.request', 'conversation.history.request')
          );
          DELETE FROM command_requests WHERE
            CASE WHEN json_valid(json) THEN json_extract(json, '$.type') END
              IN ('conversation.snapshot.request', 'conversation.history.request');
          INSERT INTO migrations VALUES (3, unixepoch() * 1000);
        `);
    })();
  }
}
