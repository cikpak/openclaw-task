import type { EngineContext } from '../manager/types.js';
import type {
  LifecycleState,
  RecoveryCheckpoint,
} from '../engine/lifecycle/types.js';
import {
  recoveryObjects,
  type RecoveryDescriptor,
} from '../engine/recovery/types.js';
import type { ManagerFiles } from './service.js';
/** Delete only unreferenced recovery objects; uncertain operations pin their descriptors. */
export class RecoveryGarbage {
  private running = false;
  constructor(
    private readonly context: EngineContext,
    private readonly files: ManagerFiles,
  ) {}
  async collect(): Promise<void> {
    if (this.running || !this.context.env.RECOVERY_BUCKET) return;
    this.running = true;
    try {
      if (
        !this.context.store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'engine_lifecycle'",
          )
          .get()
      )
        return;
      const stateRow = this.context.store.db
        .prepare('SELECT state FROM engine_lifecycle WHERE id = 1')
        .get() as { state: string } | undefined;
      if (!stateRow) return;
      const state = JSON.parse(stateRow.state) as LifecycleState;
      if (
        !['asleep', 'ready'].includes(state.phase) ||
        state.job ||
        state.pendingCheckpoint
      )
        return;
      const jobs = await this.context.state.storage.list<{
        settled?: boolean;
        descriptor?: RecoveryDescriptor;
        job: { id: string; checkpoint?: RecoveryCheckpoint };
      }>({ prefix: 'engine-helper-' });
      for (const [key, job] of jobs)
        if (job.settled) await this.context.state.storage.delete(key);
      const refs = this.context.store.db
        .prepare(
          'SELECT current,previous FROM recovery_references WHERE id = 1',
        )
        .get() as { current: string; previous: string | null } | undefined;
      if (!refs) return;
      this.context.store.db
        .prepare('UPDATE recovery_references SET previous = NULL WHERE id = 1')
        .run();
      const pinned = new Set([
        ...this.files.catalog.pinnedKeys(),
        ...this.files.uploads.pinnedKeys(),
        ...this.files.readers.keys(),
      ]);
      const pin = (descriptor?: RecoveryDescriptor) => {
        if (descriptor)
          for (const object of recoveryObjects(descriptor))
            pinned.add(object.key);
      };
      pin(
        (JSON.parse(refs.current) as RecoveryCheckpoint)
          .descriptor as unknown as RecoveryDescriptor,
      );
      for (const job of jobs.values())
        if (!job.settled) {
          pin(job.descriptor);
          pin(job.job.checkpoint?.descriptor as unknown as RecoveryDescriptor);
        }
      for (const row of this.context.store.db
        .prepare(
          'SELECT object_key FROM input_file_paths WHERE object_key IS NOT NULL',
        )
        .all() as { object_key: string }[])
        pinned.add(row.object_key);
      for (const prefix of ['recovery/', 'files/']) {
        let cursor: string | undefined;
        do {
          const page = await this.context.env.RECOVERY_BUCKET.list({
            prefix,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          });
          for (const object of page.objects) {
            const latest = this.context.store.db
              .prepare('SELECT state FROM engine_lifecycle WHERE id = 1')
              .get() as { state: string };
            if (
              !['asleep', 'ready'].includes(
                (JSON.parse(latest.state) as LifecycleState).phase,
              )
            )
              return;
            const current = this.context.store.db
              .prepare('SELECT current FROM recovery_references WHERE id = 1')
              .get() as { current: string } | undefined;
            const currentDescriptor = current
              ? ((JSON.parse(current.current) as RecoveryCheckpoint)
                  .descriptor as unknown as RecoveryDescriptor)
              : undefined;
            const nowPinned = currentDescriptor
              ? new Set(
                  recoveryObjects(currentDescriptor).map((file) => file.key),
                )
              : new Set<string>();
            for (const key of this.files.catalog.pinnedKeys())
              nowPinned.add(key);
            for (const row of this.context.store.db
              .prepare(
                'SELECT object_key FROM input_file_paths WHERE object_key IS NOT NULL',
              )
              .all() as { object_key: string }[])
              nowPinned.add(row.object_key);
            if (
              nowPinned.has(object.key) ||
              pinned.has(object.key) ||
              this.files.readers.keys().has(object.key)
            )
              continue;
            // Admission checks this durable tombstone before pinning a source.
            if (!this.files.readers.beginDelete(object.key)) continue;
            await this.context.env.RECOVERY_BUCKET.delete(object.key);
            this.files.readers.endDelete(object.key);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
    } finally {
      this.running = false;
    }
  }
}
