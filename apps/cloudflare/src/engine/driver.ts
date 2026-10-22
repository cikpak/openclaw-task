import { z } from 'zod';
import type { EngineContext } from '../manager/types.js';
import type { ChatService } from '../../../backend/src/chats/service.js';
import type { PrivateContainer } from './container.js';
import type { NativeGateway } from './gateway/native.js';
import type { LifecycleDriver, RecoveryCheckpoint } from './lifecycle/types.js';
import { RecoveryJobs } from './recovery/jobs.js';
import { materializeChats } from './creation.js';
import { RecoveryObjects } from './recovery/objects.js';
import { recoveryObjects, type RecoveryDescriptor } from './recovery/types.js';
import { assertFileIncarnations } from './recovery/incarnations.js';

export class EngineDriver implements LifecycleDriver {
  readonly objects: RecoveryObjects;
  readonly jobs: RecoveryJobs;
  constructor(
    private readonly context: EngineContext,
    readonly control: PrivateContainer,
    readonly gateway: NativeGateway,
    readonly service: ChatService,
  ) {
    this.objects = new RecoveryObjects(context.env);
    this.jobs = new RecoveryJobs(context, control, this.objects, () =>
      gateway.identity(),
    );
    context.store.db.exec(
      'CREATE TABLE IF NOT EXISTS recovery_references (id INTEGER PRIMARY KEY CHECK(id = 1), current TEXT NOT NULL, previous TEXT)',
    );
  }
  inspect() {
    return this.control.inspect();
  }
  attach() {
    return this.control.attach();
  }
  async start(bootId: string): Promise<void> {
    const row = [
      ...this.context.state.storage.sql.exec<{ state: string }>(
        'SELECT state FROM engine_lifecycle WHERE id = 1',
      ),
    ][0];
    const state = row
      ? (JSON.parse(row.state) as { initialized: boolean })
      : undefined;
    await this.control.start(
      bootId,
      await this.gateway.identity(),
      state?.initialized === true,
    );
  }
  helperStart(job: Parameters<RecoveryJobs['start']>[0]) {
    return this.jobs.start(job);
  }
  helperStatus(id: string) {
    return this.jobs.status(id);
  }
  helperCancel(job: Parameters<RecoveryJobs['cancel']>[0]) {
    return this.jobs.cancel(job);
  }
  async prepare(
    attemptId: string,
  ): Promise<{ ready: boolean; expiresAt: number }> {
    const result: unknown = await this.gateway.request(
      'gateway.suspend.prepare',
      {
        requestId: attemptId,
        drain: true,
        terminalPolicy: 'preserve',
      },
    );
    const busy = z
      .object({
        status: z.literal('busy'),
        retryAfterMs: z.number().finite().nonnegative(),
      })
      .safeParse(result);
    if (busy.success)
      return {
        ready: false,
        expiresAt:
          Date.now() + Math.max(1000, Math.min(20_000, busy.data.retryAfterMs)),
      };
    const held = z
      .object({
        status: z.enum(['ready', 'draining']),
        suspensionId: z.string().min(1),
        expiresAtMs: z.number().finite().positive(),
      })
      .parse(result);
    await this.context.state.storage.put(
      `engine-suspension-${attemptId}`,
      held.suspensionId,
    );
    return { ready: held.status === 'ready', expiresAt: held.expiresAtMs };
  }
  async resume(attemptId: string): Promise<void> {
    const suspensionId = await this.context.state.storage.get<string>(
      `engine-suspension-${attemptId}`,
    );
    if (suspensionId)
      await this.gateway.request('gateway.suspend.resume', { suspensionId });
  }
  async stopWriters(): Promise<void> {
    await this.service.drain();
    await this.control.action('stop');
    await this.beforeCapture();
  }
  async connect(): Promise<boolean> {
    const health = await this.control.health();
    if (health.gatewayState !== 'running') {
      const key = `engine-start-${health.bootId}`;
      let id = await this.context.state.storage.get<string>(key);
      let previous = id
        ? await this.control.job(id).catch(() => undefined)
        : undefined;
      if (
        !id ||
        previous?.status === 'succeeded' ||
        previous?.status === 'failed' ||
        previous?.status === 'cancelled'
      ) {
        id = `gateway-start-${crypto.randomUUID()}`;
        await this.context.state.storage.put(key, id);
        previous = undefined;
      }
      await this.control.startJob(id, health.bootId, 'start');
      const job = previous ?? (await this.control.job(id));
      if (job.status === 'running') return false;
      if (job.status !== 'succeeded') throw new Error('Gateway start failed');
    }
    this.gateway.start();
    try {
      await this.gateway.waitReady(1000);
      return true;
    } catch {
      return false;
    }
  }
  connected(): boolean {
    return this.gateway.ready;
  }
  dispatch(enabled: boolean): void {
    this.gateway.dispatch(enabled);
  }
  disconnect(): void {
    void this.gateway.stop();
  }
  additionalWork: () => boolean = () => false;
  pending(): boolean {
    if (this.additionalWork()) return true;
    return this.context.store
      .listChats()
      .some(
        (chat) =>
          this.context.store.pending(chat.id).length > 0 ||
          ['creating', 'deleting', 'running'].includes(chat.status) ||
          this.context.store.settingsOperation(chat.id) !== null,
      );
  }
  beforeCapture: () => Promise<void> = () => Promise.resolve();
  activeReaders: () => boolean = () => false;
  canStop(): boolean {
    return !this.activeReaders();
  }
  onCommit: (descriptor: RecoveryDescriptor) => void = () => {};
  busy(): Promise<boolean> {
    return Promise.resolve(
      this.activeReaders() ||
        this.pending() ||
        this.service.driving.size > 0 ||
        this.service.steering.size > 0 ||
        this.service.streams.size > 0 ||
        this.service.reconciliation !== null ||
        this.service.locks.size > 0,
    );
  }
  cancellationRequested: () => boolean = () => false;
  async verifyCheckpoint(checkpoint: RecoveryCheckpoint): Promise<void> {
    const refresh = setInterval(() => {
      this.context.state.waitUntil(this.control.attach().catch(() => {}));
    }, 20_000);
    try {
      await this.objects.verify(checkpoint, {
        signal: AbortSignal.timeout(600_000),
        shouldCancel: () => this.pending() || this.cancellationRequested(),
      });
    } finally {
      clearInterval(refresh);
    }
  }
  commit(checkpoint: RecoveryCheckpoint): void {
    const descriptor = this.objects.descriptor(checkpoint);
    const row = this.context.store.db
      .prepare('SELECT current FROM recovery_references WHERE id = 1')
      .get() as { current: string } | undefined;
    const previous = row
      ? this.objects.descriptor(JSON.parse(row.current) as RecoveryCheckpoint)
      : undefined;
    assertFileIncarnations(descriptor, previous);
    const hasDeletionTable = this.context.store.db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'file_deletions'")
      .get();
    if (
      hasDeletionTable &&
      recoveryObjects(descriptor).some((object) =>
        this.context.store.db
          .prepare('SELECT object_key FROM file_deletions WHERE object_key = ?')
          .get(object.key),
      )
    )
      throw new Error('Recovery object deletion has not settled');
    this.onCommit(descriptor);
    this.context.store.db
      .prepare(
        'INSERT INTO recovery_references VALUES (1, ?, NULL) ON CONFLICT(id) DO UPDATE SET previous = current, current = excluded.current WHERE current != excluded.current',
      )
      .run(JSON.stringify(checkpoint));
  }
  destroy() {
    return this.control.destroy();
  }
  async onReady(): Promise<void> {
    await materializeChats(this.context.store, this.gateway, this.service);
    await this.service.reconcile();
  }
}
