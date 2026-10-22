import * as proof from '../../container/native-owner/input-cancellation.mjs';
import { abortSource, slice, evaluate } from './input-cancellation-source.mjs';
import { adoption } from './input-cancellation-adoption.mjs';
import { cancellation } from './input-cancellation-abort.mjs';
/** Actual native registration/callback/cancellation code, with simulated maps/authority. */
export function fixture({
  client = {
    id: 'gateway-client',
    mode: 'cli',
    displayName: 'Messenger manager',
  },
  mode = 'followup',
} = {}) {
  const context = {
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  };
  const runId = 'input';
  const register = evaluate(
    slice(
      abortSource,
      'function registerChatAbortController(',
      '\n/** Restore the newest',
    ),
    {
      AbortController,
      normalizeOptionalLowercaseString: (value) => value?.toLowerCase(),
      getAgentEventLifecycleGeneration: () => 1,
      asDateTimestampMs: (value) => value,
      resolveDateTimestampMs: (value) => value,
      resolveChatRunExpiresAtMs: () => Date.now() + 10000,
      isFutureDateTimestampMs: () => true,
      resolveAgentRunExpiresAtMs: () => Date.now() + 10000,
      releaseAgentRunDelegatedAuthority() {},
      removeChatAbortControllerEntry: (map, id, entry) => {
        if (map.get(id) === entry) map.delete(id);
      },
    },
  );
  const registered = register({
    chatAbortControllers: context.chatAbortControllers,
    runId,
    sessionId: 'native-session',
    sessionKey: 'agent:main:main',
    agentId: 'main',
    kind: 'chat-send',
    now: Date.now(),
    expiresAtMs: Date.now() + 10000,
  });
  const entry = registered.entry;
  proof.trackInputCancellationPrelude(entry, runId, mode, client);
  return {
    context,
    entry,
    registered,
    runId,
    adoption: adoption(context, entry, runId),
    ...cancellation(context, entry, runId),
  };
}
export { sources } from './input-cancellation-source.mjs';
