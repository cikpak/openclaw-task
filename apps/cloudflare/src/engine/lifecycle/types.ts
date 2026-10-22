import type { DeadlineScheduler } from '../../manager/types.js';

export interface RecoveryCheckpoint {
  generation: string;
  manifestKey: string;
  manifestSha256: string;
  descriptor?: Record<string, unknown>;
}
export type JobKind = 'initialize' | 'restore' | 'capture' | 'resume';
export interface LifecycleJob {
  id: string;
  attemptId: string;
  bootId: string;
  kind: JobKind;
  checkpoint?: RecoveryCheckpoint;
}
export interface JobStatus {
  id: string;
  attemptId: string;
  bootId: string;
  state: 'running' | 'complete' | 'failed' | 'cancelled';
  checkpoint?: RecoveryCheckpoint;
}
/** Every helper request must return promptly; status is polled by durable alarms. */
export interface LifecycleDriver {
  onFailure?(phase: LifecyclePhase, error: unknown): void;
  inspect(): Promise<{ running: boolean; bootId?: string }>;
  attach(): Promise<void>;
  start(bootId: string): Promise<void>;
  helperStart(job: LifecycleJob): Promise<void>;
  helperStatus(id: string): Promise<JobStatus>;
  helperCancel(job: LifecycleJob): Promise<void>;
  prepare(attemptId: string): Promise<{ ready: boolean; expiresAt: number }>;
  resume(attemptId: string): Promise<void>;
  stopWriters(): Promise<void>;
  /** Return false while Gateway is starting; do not wait through an entire boot. */
  connect(): Promise<boolean | void>;
  disconnect(): void;
  connected?(): boolean;
  dispatch?(enabled: boolean): void;
  busy(): Promise<boolean>;
  /** Synchronous pending-work check shares the final stop-issuance critical section. */
  pending(): boolean;
  verifyCheckpoint(checkpoint: RecoveryCheckpoint): Promise<void>;
  /** Synchronous SQL writes join the same transaction as recovery-reference commit. */
  commit(checkpoint: RecoveryCheckpoint): void;
  canStop?(): boolean;
  destroy(): Promise<void>;
  onReady?(): Promise<void>;
}
export type LifecyclePhase =
  | 'asleep'
  | 'waking'
  | 'initializing'
  | 'restoring'
  | 'connecting'
  | 'ready'
  | 'preparing'
  | 'stopping-writers'
  | 'capturing'
  | 'verifying'
  | 'committing'
  | 'stop-issued'
  | 'cancelling'
  | 'recovering'
  | 'failed';
export interface LifecycleState {
  phase: LifecyclePhase;
  initialized: boolean;
  wantWake: boolean;
  bootId: string | null;
  attemptId: string | null;
  checkpoint: RecoveryCheckpoint | null;
  pendingCheckpoint: RecoveryCheckpoint | null;
  job: LifecycleJob | null;
  jobStartedAt: number | null;
  idleSince: number | null;
  retryAt: number;
  /** Fixed grace period after platform start for the helper listener to open. */
  helperReadyDeadline?: number;
  leaseUntil: number;
  nextAt: number | null;
  failure: 'save' | 'wake' | 'missing-checkpoint' | null;
  retryPhase: LifecyclePhase | null;
}
export interface LifecycleContext {
  storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;
  schedule: DeadlineScheduler;
}
