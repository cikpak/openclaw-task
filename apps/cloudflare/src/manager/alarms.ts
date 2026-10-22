import type { DeadlineScheduler } from './types.js';

/** Named durable deadlines share the platform's single alarm without clobbering it. */
export class ManagerAlarms implements DeadlineScheduler {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS manager_deadlines (name TEXT PRIMARY KEY, deadline INTEGER NOT NULL)',
    );
  }
  async set(name: string, deadline: number | null): Promise<void> {
    if (deadline === null)
      this.storage.sql.exec(
        'DELETE FROM manager_deadlines WHERE name = ?',
        name,
      );
    else
      this.storage.sql.exec(
        'INSERT INTO manager_deadlines VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET deadline = excluded.deadline',
        name,
        deadline,
      );
    await this.sync();
  }
  async sync(): Promise<void> {
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const row = [
          ...this.storage.sql.exec<{ deadline: number | null }>(
            'SELECT MIN(deadline) AS deadline FROM manager_deadlines',
          ),
        ][0];
        if (row?.deadline !== null && row?.deadline !== undefined)
          await this.storage.setAlarm(Math.max(Date.now() + 1, row.deadline));
        else await this.storage.deleteAlarm();
      });
    this.pending = operation;
    await operation;
  }
}
