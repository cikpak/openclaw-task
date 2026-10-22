import { LifecycleRepository } from './repository.js';
import { cancelStep, wakeStep } from './wake.js';
import { sleepStep } from './sleep.js';
import type {
  JobKind,
  JobStatus,
  LifecycleContext,
  LifecycleDriver,
  LifecyclePhase,
  LifecycleState,
  RecoveryCheckpoint,
} from './types.js';
export type * from './types.js';

const SLEEP_PHASES: LifecyclePhase[] = [
  'preparing',
  'stopping-writers',
  'capturing',
  'verifying',
  'committing',
];
const WAKE_PHASES: LifecyclePhase[] = [
  'asleep',
  'waking',
  'initializing',
  'restoring',
  'connecting',
];
const POLL_MS = 1000;
const RETRY_MS = 30_000;

/** All external operations are bounded steps, with durable identity before I/O. */
export class DurableLifecycle {
  readonly repository: LifecycleRepository;
  readonly state: LifecycleState;
  readonly idleMs: number;
  readonly now: () => number;
  private serial: Promise<void> = Promise.resolve();
  private connected = false;
  constructor(
    private readonly context: LifecycleContext,
    readonly driver: LifecycleDriver,
    options: { idleMs?: number; now?: () => number } = {},
  ) {
    driver.dispatch?.(false);
    this.repository = new LifecycleRepository(context.storage);
    this.state = this.repository.read();
    this.idleMs = options.idleMs ?? 60_000;
    this.now = options.now ?? Date.now;
    // A reconstructed manager must supervise an existing engine immediately.
    if (
      this.state.phase !== 'asleep' &&
      this.state.failure !== 'missing-checkpoint'
    )
      this.state.nextAt = this.now() + 1;
  }
  get ready(): boolean {
    return this.state.phase === 'ready' && this.connected;
  }
  get status(): LifecyclePhase {
    return this.state.phase;
  }
  deadline(): number | null {
    return this.state.nextAt;
  }
  snapshot(): LifecycleState {
    return structuredClone(this.state);
  }
  requestWake(): Promise<void> {
    this.state.wantWake = true;
    this.repository.save(this.state);
    return this.enqueue(async () => {
      if (SLEEP_PHASES.includes(this.state.phase)) this.cancel();
      if (this.state.phase === 'ready') {
        this.state.idleSince = this.now();
        this.state.wantWake = false;
      }
      if (this.state.failure === 'missing-checkpoint') return;
      if (this.state.phase === 'failed')
        this.move(this.state.retryPhase ?? 'waking');
      await this.step();
    });
  }
  tick(): Promise<void> {
    return this.enqueue(() => this.step());
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.serial
      .catch(() => {})
      .then(operation)
      .finally(async () => {
        this.repository.save(this.state);
        await this.context.schedule.set('engine-lifecycle', this.deadline());
      });
    this.serial = next;
    return next;
  }
  move(phase: LifecyclePhase, nextAt: number | null = this.now() + 1): void {
    this.state.phase = phase;
    this.state.nextAt = nextAt;
    this.repository.save(this.state);
  }
  schedule(nextAt: number | null): Promise<void> {
    this.state.nextAt = nextAt;
    this.repository.save(this.state);
    return Promise.resolve();
  }
  newJob(kind: JobKind, checkpoint?: RecoveryCheckpoint): void {
    this.state.jobStartedAt = this.now();
    this.state.job = {
      id: `${this.state.attemptId}-${kind}${kind === 'resume' ? `-${crypto.randomUUID()}` : ''}`,
      attemptId: this.state.attemptId!,
      bootId: this.state.bootId!,
      kind,
      ...(checkpoint ? { checkpoint } : {}),
    };
    this.repository.save(this.state);
  }
  async statusJob(): Promise<JobStatus> {
    const job = this.state.job!;
    const result = await this.driver.helperStatus(job.id);
    if (
      result.id !== job.id ||
      result.attemptId !== job.attemptId ||
      result.bootId !== job.bootId
    )
      throw new Error('Stale helper operation result');
    return result;
  }
  async pollJob(): Promise<JobStatus | null> {
    if (this.now() - (this.state.jobStartedAt ?? this.now()) > 15 * 60_000)
      throw new Error('Helper operation deadline exceeded');
    await this.driver.helperStart(this.state.job!);
    const result = await this.statusJob();
    if (result.state === 'failed' || result.state === 'cancelled')
      throw new Error('Helper operation failed');
    if (result.state === 'running') {
      await this.schedule(this.now() + POLL_MS);
      return null;
    }
    return result;
  }
  cancel(): void {
    this.state.pendingCheckpoint = null;
    this.move('cancelling');
  }
  failMissingCheckpoint(): void {
    this.state.failure = 'missing-checkpoint';
    this.move('failed', null);
  }
  private async step(): Promise<void> {
    const { state, driver } = this;
    if (state.phase === 'failed') {
      if (state.failure === 'missing-checkpoint') return;
      if (this.now() < state.retryAt) return this.schedule(state.retryAt);
      this.move(state.retryPhase ?? 'waking');
    }
    if (
      state.failure === 'save' &&
      state.retryAt > this.now() &&
      !state.wantWake &&
      !driver.pending()
    )
      return this.schedule(state.retryAt);
    try {
      if (!['asleep', 'waking', 'stop-issued'].includes(state.phase)) {
        const container = await driver.inspect();
        if (
          !container.running ||
          (container.bootId && container.bootId !== state.bootId)
        ) {
          this.connected = false;
          driver.dispatch?.(false);
          driver.disconnect();
          state.job = null;
          state.pendingCheckpoint = null;
          if (!state.checkpoint) return this.failMissingCheckpoint();
          state.bootId = crypto.randomUUID();
          state.attemptId = crypto.randomUUID();
          this.move('waking');
          return;
        }
        // Reapply platform inactivity and monitoring after DO recreation.
        await driver.attach();
      }
      if (
        state.phase === 'ready' &&
        this.connected &&
        driver.connected?.() === false
      ) {
        this.connected = false;
        driver.dispatch?.(false);
      }
      if (state.phase === 'ready' && !this.connected) {
        if ((await driver.connect()) === false)
          return this.schedule(this.now() + POLL_MS);
        this.connected = true;
        driver.dispatch?.(true);
        await driver.onReady?.();
      }
      if (state.wantWake && SLEEP_PHASES.includes(state.phase)) this.cancel();
      if (state.phase === 'cancelling' || state.phase === 'recovering')
        await cancelStep(this);
      else if (WAKE_PHASES.includes(state.phase)) {
        await wakeStep(this);
        if (state.phase === 'ready') this.connected = true;
      } else await sleepStep(this);
    } catch {
      driver.dispatch?.(false);
      // Save and cancellation failures retain the local disk. Never route them
      // through restore; all outstanding jobs must settle before local restart.
      if (
        SLEEP_PHASES.includes(state.phase) ||
        state.phase === 'cancelling' ||
        state.phase === 'recovering'
      ) {
        state.failure = 'save';
        state.retryAt = this.now() + RETRY_MS;
        this.connected = false;
        this.move('cancelling', state.retryAt);
      } else if (state.phase === 'stop-issued') {
        // The platform outcome is uncertain; retry shutdown before wake.
        await this.schedule(this.now() + POLL_MS);
      } else {
        this.connected = false;
        driver.disconnect();
        state.retryPhase = state.phase;
        state.failure = 'wake';
        state.retryAt = this.now() + RETRY_MS;
        this.move('failed', state.retryAt);
      }
    }
  }
}
