/** Local-only schema bootstrap; never selected by a production build. */
import worker from './auth/worker.js';
import migration from '../migrations/0001_auth.sql?raw';
import type { BackendEnv } from './auth/types.js';

let ready: Promise<void> | undefined;
async function initialize(env: BackendEnv) {
  await env.AUTH_DB.exec(
    'CREATE TABLE IF NOT EXISTS local_migrations (id INTEGER PRIMARY KEY)',
  );
  const applied = await env.AUTH_DB.prepare(
    'SELECT id FROM local_migrations WHERE id = 1',
  ).first();
  if (!applied) {
    await env.AUTH_DB.batch([
      ...migration
        .split(';')
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => env.AUTH_DB.prepare(sql)),
      env.AUTH_DB.prepare('INSERT INTO local_migrations VALUES (1)'),
    ]);
  }
}
export default {
  async fetch(request: Request, env: BackendEnv) {
    await (ready ??= initialize(env).catch((error) => {
      ready = undefined;
      throw error;
    }));
    return worker.fetch(request, env);
  },
};
