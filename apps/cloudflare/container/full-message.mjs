import { readFile } from 'node:fs/promises';
import { audit } from './configuration.mjs';
/** Immutable internal module paths belong to the pinned OpenClaw image, not an SDK replacement. */
const modules = () =>
  Promise.all([
    import('/app/dist/session-utils-store-DT1w1HJu.mjs'),
    import('/app/dist/session-transcript-readers-C__bw85l.mjs'),
    import('/app/dist/chat-display-projection.core-2vpXU5tC.mjs'),
  ]);
function sameSession(left, right) {
  return (
    left.agentId === right.agentId &&
    left.canonicalKey === right.canonicalKey &&
    left.storePath === right.storePath &&
    left.entry?.sessionId === right.entry?.sessionId &&
    left.entry?.lifecycleRevision === right.entry?.lifecycleRevision
  );
}
/** Exact selected agent/session only; raw reasoning, tools, system and metadata never leave this helper. */
export async function fullMessage({ agentId, sessionKey, messageId }, signal) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(agentId ?? '') ||
    sessionKey !== `agent:${agentId}:main` ||
    typeof messageId !== 'string' ||
    !messageId ||
    messageId.length > 256
  )
    throw new Error('Invalid message scope');
  signal?.throwIfAborted();
  await audit();
  const config = JSON.parse(
    await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'),
  );
  if (!Object.hasOwn(config.agents?.entries ?? {}, agentId))
    throw new Error('Unknown message owner');
  const [store, transcript, display] = await modules();
  const before = store.loadGatewaySessionEntryReadOnly(
    sessionKey,
    { agentId },
    config,
  );
  if (
    before.agentId !== agentId ||
    before.canonicalKey !== sessionKey ||
    !before.entry?.sessionId
  )
    throw new Error('Message session unavailable');
  const found = await transcript.readSessionMessageByIdAsync(
    {
      agentId,
      sessionKey,
      sessionId: before.entry.sessionId,
      sessionEntry: before.entry,
      storePath: before.storePath,
    },
    messageId,
    { allowResetArchiveFallback: false, currentOnly: true, readOnly: true },
  );
  signal?.throwIfAborted();
  if (
    !found.found ||
    found.oversized ||
    !sameSession(
      before,
      store.loadGatewaySessionEntryReadOnly(sessionKey, { agentId }, config),
    )
  )
    throw new Error('Message changed while reading');
  const message = display.projectChatDisplayMessage(found.message, {
    maxChars: Number.MAX_SAFE_INTEGER,
    activity: false,
  });
  const id = message?.__openclaw?.id ?? message?.id ?? message?.messageId;
  if (
    id !== messageId ||
    !['user', 'assistant'].includes(message?.role) ||
    message.__openclaw?.truncated ||
    (message.channel &&
      message.channel !== 'final' &&
      message.channel !== 'commentary')
  )
    throw new Error('Message not publicly visible');
  const content =
    typeof message.content === 'string'
      ? message.content
      : (message.content ?? [])
          .filter(
            (part) => part?.type === 'text' && typeof part.text === 'string',
          )
          .map((part) => part.text)
          .join('');
  return {
    id,
    role: message.role,
    content,
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    __openclaw: {
      id,
      ...(typeof message.__openclaw?.runId === 'string'
        ? { runId: message.__openclaw.runId }
        : {}),
      ...(Number.isInteger(message.__openclaw?.seq)
        ? { seq: message.__openclaw.seq }
        : {}),
    },
  };
}
