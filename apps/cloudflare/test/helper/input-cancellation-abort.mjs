import {
  abortSource,
  slice,
  evaluate,
  noop,
} from './input-cancellation-source.mjs';
import { plan } from './input-cancellation-plan.mjs';
export function cancellation(context, entry, runId) {
  const ops = {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: {
      runs: new Map(),
      resolveBuffer: () => ({ text: '' }),
      getOrCreate(id) {
        if (!this.runs.has(id)) this.runs.set(id, {});
        return this.runs.get(id);
      },
      clearRun(id) {
        this.runs.delete(id);
      },
    },
    removeChatRun: () => undefined,
    agentRunSeq: new Map(),
    onRunAborted: noop,
  };
  context.chatRunState = ops.chatRunState;
  let onLifecycle = noop;
  const abortById = evaluate(
    slice(
      abortSource,
      'function abortChatRunById(',
      '\nfunction updateChatRunProvider',
    ),
    {
      isChatAbortControllerEntryAbortable: (current) =>
        !current.controller.signal.aborted &&
        current.isAbortable?.(current) !== false,
      appendChatCanvasBlocksToMessage: (message) => message,
      createChatAbortMarker: () => Date.now(),
      createChatAbortSignalReason: () => undefined,
      releaseAgentRunDelegatedAuthority: noop,
      broadcastChatAborted: noop,
      emitAgentEvent: (event) => onLifecycle(event),
      removeChatAbortControllerEntry: (map, id, current) => {
        if (map.get(id) === current) map.delete(id);
      },
    },
  );
  return {
    ...plan(context, entry, runId, ops, abortById),
    ops,
    setLifecycle: (callback) => {
      onLifecycle = callback;
    },
  };
}
