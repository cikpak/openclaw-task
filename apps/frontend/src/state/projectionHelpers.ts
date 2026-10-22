import type {
  ChatSnapshot,
  ConversationEvent,
  Message,
  ToolActivity,
} from '@messenger/contracts';
/** One display boundary for snapshots and older pages. Unknown positions stay stable. */
export function chronological(messages: Message[]): Message[] {
  const unique = [
    ...new Map(messages.map((message) => [message.id, message])).values(),
  ];
  const sequenced = unique.filter(
    (message) => message.historySequence !== undefined,
  );
  const ordered =
    sequenced.length > 1
      ? sequenced.sort((a, b) => a.historySequence! - b.historySequence!)
      : unique
          .filter((message) => message.createdAt > 0)
          .sort((a, b) => a.createdAt - b.createdAt);
  const positioned = new Set(ordered.map((message) => message.id));
  let index = 0;
  return unique.map((message) =>
    positioned.has(message.id) ? ordered[index++]! : message,
  );
}
export function withoutKey<T>(
  map: Record<string, T>,
  key: string,
): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}
export function toolWatermarks(
  tools: ToolActivity[],
  sequences: Record<string, number>,
): Record<string, number> {
  const retained: Record<string, number> = {};
  for (const tool of tools) {
    const sequence = sequences[tool.id];
    if (sequence !== undefined) retained[tool.id] = sequence;
  }
  return retained;
}
export function projectRun(
  previous: ChatSnapshot['activeRun'],
  event: Extract<ConversationEvent, { type: 'conversation.run.text' }>,
) {
  const text = event.replace
    ? event.text
    : (previous?.id === event.runId ? previous.text : '') + event.text;
  return {
    id: event.runId,
    sequence: event.runSequence,
    text: text.slice(0, 256 * 1024),
    truncated:
      text.length > 256 * 1024 ||
      (event.truncated ??
        (event.replace ? false : (previous?.truncated ?? false))),
  };
}
