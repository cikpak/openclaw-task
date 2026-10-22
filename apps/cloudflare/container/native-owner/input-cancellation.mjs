/** Exact original-controller prelude state. This is proof, never native authority. */
const phases = new WeakMap();
const seen = new WeakSet();
const object = (value) => value !== null && typeof value === 'object';
const exact = (value) =>
  typeof value === 'string' && value.length > 0 && value === value.trim();
export function trackInputCancellationPrelude(entry, inputId, mode, client) {
  if (!object(entry) || seen.has(entry)) return;
  seen.add(entry);
  if (
    mode !== 'followup' ||
    client?.id !== 'gateway-client' ||
    client.mode !== 'cli' ||
    client.displayName !== 'Messenger manager'
  )
    return;
  if (![inputId, entry.sessionId, entry.sessionKey, entry.agentId].every(exact))
    return;
  phases.set(entry, {
    eligible: true,
    inputId,
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    agentId: entry.agentId,
  });
}
export function retireInputCancellationPrelude(entry) {
  if (!object(entry)) return;
  seen.add(entry);
  const state = phases.get(entry);
  if (state) state.eligible = false;
}
/** Caller must invoke the returned closure only after native synchronous abort
 * returned success for this same authorized current controller. */
export function beginInputCancellationProof(context, inputId, entry) {
  const state = object(entry) && phases.get(entry);
  const controller = entry?.controller;
  const matches = () =>
    state?.eligible === true &&
    state.inputId === inputId &&
    entry.kind === 'chat-send' &&
    entry.controller === controller &&
    entry.sessionId === state.sessionId &&
    entry.sessionKey === state.sessionKey &&
    entry.agentId === state.agentId &&
    entry.executionStarted === false &&
    !context.chatQueuedTurns.has(inputId);
  if (
    !matches() ||
    context.chatAbortControllers.get(inputId) !== entry ||
    controller?.signal?.aborted !== false ||
    entry.registrationCleanupRequested
  )
    return;
  return () => {
    const current = context.chatAbortControllers.get(inputId);
    if (
      !matches() ||
      (current !== undefined && current !== entry) ||
      controller.signal.aborted !== true ||
      entry.registrationCleanupRequested !== true
    )
      return;
    return {
      kind: 'pre-execution-input-cancelled',
      inputId,
      sessionId: state.sessionId,
      sessionKey: state.sessionKey,
      agentId: state.agentId,
    };
  };
}
