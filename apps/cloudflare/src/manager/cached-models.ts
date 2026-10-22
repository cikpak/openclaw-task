import type { ModelCapability } from '@messenger/contracts';
import type { Store } from '../../../backend/src/storage/store.js';
export function modelCache(store: Store) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS model_catalog (scope TEXT PRIMARY KEY, json TEXT NOT NULL)',
  );
  return {
    read(scope?: string): ModelCapability[] {
      const row = store.db
        .prepare('SELECT json FROM model_catalog WHERE scope = ?')
        .get(scope ?? 'defaults') as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as ModelCapability[]) : [];
    },
    save(models: ModelCapability[], scope?: string) {
      store.db
        .prepare(
          'INSERT OR REPLACE INTO model_catalog (scope, json) VALUES (?, ?)',
        )
        .run(scope ?? 'defaults', JSON.stringify(models));
    },
  };
}
