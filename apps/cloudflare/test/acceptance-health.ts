type Storage = Pick<DurableObjectStorage, 'sql'>;
export function healthFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error';
  const cause = error.cause as { code?: unknown } | undefined;
  if (
    cause?.code === 'ECONNREFUSED' ||
    /connection refused/iu.test(error.message)
  )
    return 'connection-refused';
  if (error.name === 'TimeoutError' || error.name === 'AbortError')
    return 'timeout';
  if (error.message === 'Private engine helper unavailable')
    return 'http-rejected';
  if (error.name === 'TypeError') return 'type-error';
  return 'other';
}
/** Test-only counters measure helper health calls, not lifecycle attempts. */
export function observeHealth(storage: Storage, event: string): void {
  try {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS acceptance_health (event TEXT PRIMARY KEY, count INTEGER NOT NULL, last_at INTEGER NOT NULL)',
    );
    storage.sql.exec(
      'INSERT INTO acceptance_health VALUES (?, 1, ?) ON CONFLICT(event) DO UPDATE SET count = MIN(count + 1, 1000000), last_at = excluded.last_at',
      event,
      Date.now(),
    );
  } catch {
    // Diagnostic persistence must not replace the original health outcome.
  }
}
export function healthObservations(storage: Storage) {
  const table = [
    ...storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE name = 'acceptance_health'",
    ),
  ];
  if (!table.length) return [];
  return [
    ...storage.sql.exec<{ event: string; count: number; last_at: number }>(
      'SELECT event,count,last_at FROM acceptance_health ORDER BY event',
    ),
  ];
}
