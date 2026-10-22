import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { Store } from '../src/database.js';
import {
  DurableObjectStore,
  type DurableSqlStorage,
} from '../src/storage/durable-object.js';
import type {
  ChatRecord,
  Store as PortableStore,
} from '../src/storage/store.js';
import { sha256 } from '../src/portable/sha256.js';
import { testSettings } from './fake-gateway.js';

it('retains SHA-256 fingerprints for Unicode and every padding boundary', () => {
  for (const input of [
    '',
    'abc',
    '🤗 Привет 世界',
    ...Array.from({ length: 130 }, (_, i) => 'x'.repeat(i)),
    'large'.repeat(40_000),
  ]) {
    expect(sha256(input)).toBe(
      createHash('sha256').update(input).digest('hex'),
    );
  }
});

/** A real SQLite engine exposes the Durable Object cursor/transaction shape. */
function durableSql(db: Database.Database): DurableSqlStorage {
  return {
    sql: {
      exec(query, ...bindings) {
        if (bindings.length === 0 && query.includes(';')) {
          db.exec(query);
          return [];
        }
        const statement = db.prepare(query);
        if (statement.reader)
          return statement.all(...bindings) as Record<string, unknown>[];
        statement.run(...bindings);
        return [];
      },
    },
    transactionSync: (work) => db.transaction(work)(),
  };
}

it.each(['node', 'durable'] as const)(
  'preserves nested transactions, mutation identities, and deletion with the %s adapter',
  (adapter) => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const store: PortableStore =
      adapter === 'node'
        ? new Store(':memory:')
        : new DurableObjectStore(durableSql(db));
    try {
      const chat: ChatRecord = {
        id: randomUUID(),
        name: 'portable',
        status: 'idle',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        unread: false,
        settings: testSettings,
        agentId: 'agent',
        sessionKey: 'agent:agent:main',
        creationId: randomUUID(),
      };
      store.db.transaction(() => {
        store.reserveChat(chat);
        store.saveCreationCommand(chat.creationId, chat.id, { original: true });
        expect(() =>
          store.db.transaction(() => {
            store.saveMetadata(chat.id, {
              manualName: true,
              creationInput: 'rollback',
            });
            throw new Error('rollback');
          })(),
        ).toThrow('rollback');
        expect(store.metadata(chat.id).manualName).toBe(false);
        store.saveMetadata(chat.id, {
          manualName: true,
          creationInput: 'committed',
        });
      })();
      store.saveCommandRequest('mutation', '{"operation":"first"}');
      store.saveCommandRequest('mutation', '{"operation":"second"}');
      expect(store.commandRequest('mutation')).toBe('{"operation":"first"}');
      store.savePending({
        id: 'message',
        chatId: chat.id,
        position: 1,
        revision: 1,
        text: 'persisted',
        attachments: [],
        state: 'pending',
        submissionId: 'run',
        createdAt: 1,
      });
      store.saveSubmissionScope('message', 'session');
      expect(store.pending(chat.id)).toHaveLength(1);
      expect(store.submissionScope('message')).toBe('session');
      const persisted = store.getChat(chat.id);
      store.saveTombstone(persisted);
      store.removeChat(chat.id);
      expect(store.listChats()).toEqual([]);
      expect(store.creationCommand(chat.creationId)?.deleted).toBe(true);
      expect(store.submissionScope('message')).toBeNull();
      expect(store.tombstones()).toEqual([persisted]);
      expect(store.commandRequest('mutation')).toBe('{"operation":"first"}');
    } finally {
      store.close();
      db.close();
    }
  },
);
