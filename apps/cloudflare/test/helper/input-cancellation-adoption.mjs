import * as proof from '../../container/native-owner/input-cancellation.mjs';
import {
  sources,
  slice,
  evaluate,
  noop,
} from './input-cancellation-source.mjs';
/** Original native adoption callbacks; queue custody is simulated in this unit fixture. */
export function adoption(context, entry, runId) {
  return evaluate(
    slice(
      sources.get('chat-send-handler-MxN0361b.mjs'),
      'function createChatSendTurnAdoptionLifecycle(',
      '\n//#endregion',
    ),
    {
      ...proof,
      createChatSendLateReplyFinalizer: () => noop,
      normalizeOptionalString: (value) => value?.trim(),
      createChatSendLateFollowupDisposition: () => ({
        recordQueued: noop,
        deliver: noop,
      }),
      registerQueuedChatTurn: ({
        runId,
        controller,
        sessionId,
        sessionKey,
        agentId,
      }) => {
        context.chatQueuedTurns.set(runId, {
          controller,
          sessionId,
          sessionKey,
          agentId,
        });
        return true;
      },
      retireQueuedChatTurnCancellation: () => true,
      completeQueuedChatTurn: () => true,
      createDeferredCore: () => Promise.withResolvers(),
      setGatewayDedupeEntry: noop,
    },
  )({
    context,
    sessionBinding: entry,
    sessionKey: entry.sessionKey,
    agentId: entry.agentId,
    runId,
    controller: entry.controller,
    chatQueuedTurns: context.chatQueuedTurns,
    retainWorkAdmission: () => noop,
    releaseSourceWorkAdmission: noop,
  });
}
