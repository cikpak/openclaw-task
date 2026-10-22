// Validate only a private database clone; never open the stopped source database.
import { DatabaseSync } from 'node:sqlite';

let database;
try {
  // Let SQLite fully validate CHECK constraints and journals on this expendable
  // clone. The original database and its sidecars are never opened here.
  database = new DatabaseSync(process.argv[2]);
  const rows = database.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok')
    throw new Error('SQLite integrity check failed');
} catch (error) {
  console.error(
    JSON.stringify({
      name: error.name,
      code: error.code,
      message: error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  database?.close();
}
