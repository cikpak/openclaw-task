import type { LifecyclePhase } from './lifecycle/types.js';
type Operation = 'inspect' | 'identity' | 'start' | 'attach' | 'lifecycle';
type Status = 'entered' | 'completed' | 'failed';
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
function category(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error';
  // Inspect messages only to choose fixed labels; never emit any error values.
  if (error.message.includes('There is no container application assigned'))
    return 'namespace-unassigned';
  if (error.message === 'Private engine binding unavailable')
    return 'binding-unavailable';
  if (error.message === 'Private engine helper unavailable')
    return 'helper-unavailable';
  if (
    /image.*(?:not found|not ready|not imported|unavailable)/iu.test(
      error.message,
    )
  )
    return 'image-unavailable';
  if (/instance.*(?:not supported|invalid|not allowed)/iu.test(error.message))
    return 'instance-unavailable';
  if (error.name === 'TimeoutError' || error.name === 'AbortError')
    return 'timeout';
  if (error.name === 'TypeError') return 'type-error';
  if (error.name === 'RangeError') return 'range-error';
  if (error.name === 'OperationError') return 'operation-error';
  return 'other';
}
/** Finite structural-only events per in-memory boot attempt; no identifiers/values. */
export class WakeDiagnostics {
  private boot: string | undefined;
  private readonly emitted = new Set<string>();
  begin(boot: string): void {
    if (this.boot === boot) return;
    this.boot = boot;
    this.emitted.clear();
  }
  private emit(
    operation: Operation,
    status: Status,
    reason = 'none',
    phase = 'wake',
  ): void {
    const key = `${operation}:${status}`;
    if (this.emitted.has(key)) return;
    this.emitted.add(key);
    console.log(
      JSON.stringify({
        event: 'engine-wake',
        operation,
        phase,
        status,
        reason,
      }),
    );
  }
  async run<T>(
    operation: Exclude<Operation, 'lifecycle'>,
    work: () => T | Promise<T>,
  ): Promise<T> {
    this.emit(operation, 'entered');
    try {
      const value = await work();
      this.emit(operation, 'completed');
      return value;
    } catch (error) {
      this.emit(operation, 'failed', category(error));
      throw error;
    }
  }
  failure(phase: LifecyclePhase, error: unknown): void {
    this.emit(
      'lifecycle',
      'failed',
      category(error),
      phases.has(phase) ? phase : 'other',
    );
  }
}
