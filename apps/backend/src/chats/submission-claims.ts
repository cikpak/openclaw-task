import type { PendingMessage } from '@messenger/contracts';
import type { ServiceState } from './service-state.js';
/** These process-local claims prove only that this live owner has not invoked
 * Gateway. Reconstruction deliberately loses that proof and stays uncertain. */
export function claimSubmission(ctx: ServiceState, item: PendingMessage): void {
  ctx.uninvokedSubmissions.set(item.id, {
    revision: item.revision,
    submissionId: item.submissionId,
    epoch: ctx.connectionEpoch,
  });
  item.state = 'submitting';
}
export function locallyUninvoked(
  ctx: ServiceState,
  item: PendingMessage,
): boolean {
  const claim = ctx.uninvokedSubmissions.get(item.id);
  return (
    !ctx.closed &&
    claim?.revision === item.revision &&
    claim.submissionId === item.submissionId
  );
}
export function releaseSubmission(
  ctx: ServiceState,
  item: PendingMessage,
): void {
  const claim = ctx.uninvokedSubmissions.get(item.id);
  if (
    claim?.revision === item.revision &&
    claim.submissionId === item.submissionId
  )
    ctx.uninvokedSubmissions.delete(item.id);
}
export function invalidateChatSubmissions(ctx: ServiceState, id: string): void {
  for (const item of ctx.store.pending(id)) releaseSubmission(ctx, item);
}
