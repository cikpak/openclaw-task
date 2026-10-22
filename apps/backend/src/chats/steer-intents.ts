import type { PendingMessage } from '@messenger/contracts';
import type { Store } from '../storage/store.js';

/** Private admission intent: editing or changing the active run never retargets it. */
export function saveSteerIntent(
  store: Store,
  item: PendingMessage,
  targetRunId: string,
): void {
  store.db
    .prepare('INSERT INTO pending_steer_intents VALUES (?, ?, ?)')
    .run(item.id, item.revision, targetRunId);
}
export function steerTarget(store: Store, item: PendingMessage): string | null {
  const row = store.db
    .prepare(
      'SELECT revision,target_run_id AS target FROM pending_steer_intents WHERE message_id=?',
    )
    .get(item.id) as { revision: number; target: string } | undefined;
  return row?.revision === item.revision ? row.target : null;
}
export function consumeSteerIntent(store: Store, id: string): void {
  store.db
    .prepare('DELETE FROM pending_steer_intents WHERE message_id=?')
    .run(id);
}
