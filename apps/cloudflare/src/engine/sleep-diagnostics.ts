import type { LifecycleState } from './lifecycle/types.js';

const phases = new Set([
  'asleep',
  'waking',
  'initializing',
  'restoring',
  'connecting',
  'ready',
  'preparing',
  'stopping-writers',
  'capturing',
  'verifying',
  'committing',
  'stop-issued',
  'cancelling',
  'recovering',
  'failed',
]);
const kinds = new Set(['initialize', 'restore', 'capture', 'resume']);
const failureReasons = new Map([
  ['Helper operation failed', 'helper-failed'],
  ['Private engine operation failed', 'helper-failed'],
  ['Helper operation deadline exceeded', 'helper-deadline'],
  ['Private engine operation deadline exceeded', 'helper-deadline'],
  ['Private engine helper unavailable', 'helper-unavailable'],
  ['Invalid recovery reference', 'invalid-reference'],
  ['Expected recovery reference missing', 'invalid-reference'],
  ['Recovery reference mismatch', 'reference-mismatch'],
  ['Invalid recovery object', 'invalid-object'],
  ['Invalid recovery generation', 'invalid-reference'],
  ['Invalid recovery file checksum', 'invalid-object'],
  ['Recovery file key incarnation is not coherent', 'invalid-object'],
  ['Private recovery signing unavailable', 'signing-unavailable'],
  ['Invalid private recovery origin', 'signing-unavailable'],
  ['Invalid private recovery bucket', 'signing-unavailable'],
  ['Recovery bucket unavailable', 'bucket-unavailable'],
  ['Recovery object missing or incomplete', 'object-missing'],
  ['Recovery object metadata changed', 'object-metadata-mismatch'],
  ['Stale private operation result', 'stale-operation'],
  ['Stale private engine operation', 'stale-operation'],
  ['Stale helper operation result', 'stale-operation'],
  ['Helper operation identity reused', 'operation-identity'],
  ['Private operation record unavailable', 'operation-unavailable'],
  ['Recovery descriptor unavailable', 'descriptor-unavailable'],
  ['Recovery readback verification mismatch', 'verification-mismatch'],
  ['Recovery readback completion unavailable', 'verification-unavailable'],
  ['Recovery object deletion has not settled', 'deletion-unsettled'],
  ['Preservation cancelled', 'preservation-cancelled'],
]);
const blockers = new Set([
  'queue',
  'reply',
  'embedded-run',
  'background-exec',
  'cron-run',
  'agent-run',
  'acp-run',
  'media-generation',
  'root-request',
  'session-admission',
  'session-mutation',
  'chat-run',
  'queued-turn',
  'terminal-persistence',
  'terminal-session',
]);
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1_000_000, Math.floor(value)))
    : 0;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const label = (value: unknown, allowed: Set<string>) =>
  typeof value === 'string' && allowed.has(value) ? value : 'other';
export interface SleepActivity {
  liveReaders: boolean;
  fileWork: boolean;
  pendingMessages: number;
  creatingChats: number;
  deletingChats: number;
  runningChats: number;
  settingsOperations: number;
  driving: number;
  steering: number;
  streams: number;
  reconciliation: boolean;
  locks: number;
  gatewayReady: boolean;
}
/** Fixed fields only; no native text, identities, descriptors, paths or exception strings. */
export class SleepDiagnostics {
  private readonly channels = new Map<
    string,
    { signature: string; at: number; window: number; count: number }
  >();
  constructor(
    private readonly output: (value: string) => void = (value) =>
      console.info(value),
    private readonly now: () => number = Date.now,
  ) {}
  private emit(channel: string, fields: object, timing: object = {}): void {
    const now = this.now();
    const signature = JSON.stringify(fields);
    const prior = this.channels.get(channel);
    if (prior?.signature === signature && now - prior.at < 300_000) return;
    const withinWindow = prior && now - prior.window < 60_000;
    if (withinWindow && prior.count >= 20) return;
    this.channels.set(channel, {
      signature,
      at: now,
      window: withinWindow ? prior.window : now,
      count: withinWindow ? prior.count + 1 : 1,
    });
    try {
      this.output(
        JSON.stringify({
          event: 'engine-sleep',
          observation: channel,
          ...fields,
          ...timing,
        }),
      );
    } catch {
      /* Diagnostics never change engine control flow. */
    }
  }
  lifecycle(
    state: LifecycleState,
    activity: SleepActivity,
    loaded = false,
  ): void {
    const fields: Record<string, string | number | boolean | null> = {
      phase: label(state.phase, phases),
      source: loaded === true ? 'loaded' : 'tick',
      failure:
        state.failure === null
          ? null
          : label(
              state.failure,
              new Set(['save', 'wake', 'missing-checkpoint']),
            ),
      jobKind: state.job ? label(state.job.kind, kinds) : null,
      wantWake: state.wantWake === true,
      hasCheckpoint: state.checkpoint !== null,
      hasPendingCheckpoint: state.pendingCheckpoint !== null,
    };
    for (const key of [
      'liveReaders',
      'fileWork',
      'reconciliation',
      'gatewayReady',
    ] as const)
      fields[key] = activity[key] === true;
    for (const key of [
      'pendingMessages',
      'creatingChats',
      'deletingChats',
      'runningChats',
      'settingsOperations',
      'driving',
      'steering',
      'streams',
      'locks',
    ] as const)
      fields[key] = count(activity[key]);
    this.emit('lifecycle', fields, {
      idleAgeMs:
        state.idleSince === null
          ? null
          : Math.max(0, this.now() - state.idleSince),
      jobAgeMs:
        state.jobStartedAt === null
          ? null
          : Math.max(0, this.now() - state.jobStartedAt),
      retryInMs: Math.max(0, state.retryAt - this.now()),
      leaseInMs: Math.max(0, state.leaseUntil - this.now()),
    });
  }
  suspension(value: unknown): void {
    const result = record(value);
    const counts: Record<string, number> = {};
    for (const entry of Array.isArray(result.blockers) ? result.blockers : []) {
      const item = record(entry),
        kind = label(item.kind, blockers);
      counts[kind] = count((counts[kind] ?? 0) + count(item.count));
    }
    this.emit('suspension', {
      status: label(result.status, new Set(['busy', 'ready', 'draining'])),
      reason:
        result.reason === undefined
          ? null
          : label(result.reason, new Set(['active-work', 'gateway-draining'])),
      activeCount: count(result.activeCount),
      blockers: Object.fromEntries(
        Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      writeCustodyPresent: result.writeCustody !== undefined,
      writeCustodyShape: Array.isArray(result.writeCustody)
        ? 'array'
        : result.writeCustody === undefined
          ? 'absent'
          : 'other',
      writeCustodyCount: Array.isArray(result.writeCustody)
        ? (result.writeCustody as unknown[]).reduce<number>(
            (sum, entry) => count(sum + count(record(entry).count)),
            0,
          )
        : null,
    });
  }
  helper(kind: unknown, stage: unknown, status: unknown): void {
    this.emit('helper', {
      jobKind: label(kind, kinds),
      stage: label(stage, new Set(['primary', 'upload', 'complete'])),
      status: label(
        status,
        new Set(['running', 'succeeded', 'failed', 'cancelled', 'unavailable']),
      ),
    });
  }
  failure(phase: unknown, error: unknown): void {
    const reason =
      error instanceof Error
        ? (failureReasons.get(error.message) ??
          (['TimeoutError', 'AbortError'].includes(error.name)
            ? 'timeout'
            : 'other'))
        : 'other';
    this.emit('failure', { phase: label(phase, phases), reason });
  }
}
