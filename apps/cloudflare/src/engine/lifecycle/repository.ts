import type { LifecycleContext, LifecycleState } from './types.js';

export class LifecycleRepository {
  constructor(private readonly storage: LifecycleContext['storage']) {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS engine_lifecycle (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)',
    );
  }
  read(): LifecycleState {
    const row = [
      ...this.storage.sql.exec<{ state: string }>(
        'SELECT state FROM engine_lifecycle WHERE id = 1',
      ),
    ][0];
    return row
      ? (JSON.parse(row.state) as LifecycleState)
      : {
          phase: 'asleep',
          initialized: false,
          wantWake: false,
          bootId: null,
          attemptId: null,
          checkpoint: null,
          pendingCheckpoint: null,
          job: null,
          jobStartedAt: null,
          idleSince: null,
          retryAt: 0,
          leaseUntil: 0,
          nextAt: null,
          failure: null,
          retryPhase: null,
        };
  }
  save(state: LifecycleState): void {
    this.storage.sql.exec(
      'INSERT INTO engine_lifecycle VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      JSON.stringify(state),
    );
  }
  transaction(operation: () => void): void {
    this.storage.transactionSync(operation);
  }
}
