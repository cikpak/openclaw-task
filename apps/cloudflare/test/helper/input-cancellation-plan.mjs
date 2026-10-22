import * as proof from '../../container/native-owner/input-cancellation.mjs';
import {
  sources,
  slice,
  evaluate,
  noop,
} from './input-cancellation-source.mjs';
/** Execute the actual patched native cancellation branch with simulated authorization. */
export function plan(context, entry, runId, ops, abortById) {
  let pendingOnly = false;
  const prepare = evaluate(
    slice(
      sources.get('chat-abort-runtime-HvpXWrR-.mjs'),
      'function prepareChatSessionAbort(',
      '\nasync function abortChatRunsForSessionKeyWithPartials',
    ),
    {
      ...proof,
      Set,
      Date,
      resolveAuthorizedQueuedTurnsForSession: () => ({
        authorized: [],
        matchedRunIds: [],
        hasUnauthorizedRuns: false,
      }),
      resolveAuthorizedRunsForSessionKeys: () => ({
        authorizedRuns: pendingOnly
          ? []
          : [
              {
                runId,
                sessionKey: entry.sessionKey,
                sessionId: entry.sessionId,
                agentId: entry.agentId,
                entry,
              },
            ],
        matchedRunIds: [runId],
        hasUnauthorizedRuns: false,
        hasUnauthorizedProtectedRuns: false,
        hasProtectedRuns: false,
      }),
      resolveAuthorizedPreRegisteredRunsForSessionKeys: ({ keyPrefix }) => ({
        authorizedRuns:
          pendingOnly && keyPrefix !== 'agent:' ? [{ runId, payload: {} }] : [],
        matchedRunIds: [],
        hasUnauthorizedRuns: false,
        hasProtectedRuns: false,
        hasUnauthorizedProtectedRuns: false,
      }),
      PENDING_CHAT_SEND_DEDUPE_PREFIX: 'chat-send:',
      abortChatRunById: abortById,
      abortQueuedChatTurnById: noop,
      writePreRegisteredAgentAbort: () => false,
      writePreRegisteredChatAbort: () => true,
      normalizeOptionalString: (value) => value?.trim(),
      deferAbortedPartialPersistence: noop,
      captureAbortedPartial: noop,
      persistAbortedPartials: async () => undefined,
    },
  );
  return {
    cancel() {
      const plan = prepare({
        context,
        ops,
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        agentId: entry.agentId,
        requester: { isAdmin: false },
        assertCurrent: noop,
        stopReason: 'rpc',
      });
      plan.abort();
      return plan.result;
    },
    pendingOnly() {
      pendingOnly = true;
      context.chatAbortControllers.delete(runId);
    },
  };
}
