import { z } from 'zod';
import type { ToolActivity } from '@messenger/contracts';
import type { GatewayEvent } from './types.js';

const toolSchema = z.object({
  stream: z.literal('tool'),
  sessionKey: z.string().max(512),
  runId: z.string().max(256),
  seq: z.number().int().nonnegative(),
  data: z.object({
    phase: z.enum(['start', 'update', 'result']),
    toolCallId: z.string().max(256),
    name: z.string().max(100),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    partialResult: z.unknown().optional(),
    isError: z.boolean().optional(),
  }),
});
const secretKey =
  /password|secret|token|authorization|api[_-]?key|cookie|credential/i;
function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-|sk-ant-)[a-zA-Z0-9_-]{10,}/g, '[redacted]');
}
function bounded(value: unknown, max: number): string {
  let visited = 0;
  function safe(input: unknown, depth: number): unknown {
    if (++visited > 150 || depth > 6) return '[preview truncated]';
    // Match complete credentials before truncation can shorten them below the
    // redactor's minimum length, including strings nested inside tool results.
    if (typeof input === 'string') return redact(input).slice(0, max);
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'number'
    )
      return input;
    if (Array.isArray(input))
      return input.slice(0, 30).map((entry) => safe(entry, depth + 1));
    if (typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .slice(0, 30)
          .map(([key, entry]) => [
            key.slice(0, 100),
            secretKey.test(key) ? '[redacted]' : safe(entry, depth + 1),
          ]),
      );
    return '';
  }
  const projected = safe(value, 0);
  const text =
    typeof projected === 'string' ? projected : JSON.stringify(projected);
  return redact(text ?? '')
    .split('')
    .filter(
      (character) =>
        character === '\n' ||
        character === '\r' ||
        character === '\t' ||
        (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
    )
    .join('')
    .slice(0, max);
}
/** Shared projection for live, canonical, and previously cached tool output. */
export function projectToolText(value: unknown): string {
  return bounded(value, 8192);
}
export function projectToolEvent(
  value: unknown,
): Extract<GatewayEvent, { type: 'tool' }> | null {
  const parsed = toolSchema.safeParse(value);
  if (!parsed.success) return null;
  const event = parsed.data;
  // Configuration, shell, and cross-agent tools never form part of the product surface.
  if (!['read', 'write', 'edit', 'web_fetch'].includes(event.data.name))
    return null;
  const tool: ToolActivity = {
    id: `${event.runId}:${event.data.toolCallId}`,
    name: event.data.name,
    status: event.data.isError
      ? 'failed'
      : event.data.phase === 'result'
        ? 'completed'
        : 'running',
    parameters: bounded(event.data.args, 4096),
    output: projectToolText(event.data.result ?? event.data.partialResult),
  };
  return {
    type: 'tool',
    sessionKey: event.sessionKey,
    runId: event.runId,
    sequence: event.seq,
    tool,
  };
}

/** Canonical transcript tool calls/results restore completed activity missed while the backend was offline. */
export function projectTranscriptTools(messages: unknown[]): ToolActivity[] {
  const tools = new Map<string, ToolActivity>();
  const messageSchema = z.object({
    role: z.string(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    content: z.unknown().optional(),
    runId: z.string().optional(),
    __openclaw: z.object({ runId: z.string().optional() }).optional(),
  });
  const callSchema = z.object({
    type: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    arguments: z.unknown().optional(),
  });
  const allowed = new Set(['read', 'write', 'edit', 'web_fetch']);
  for (const raw of messages.slice(-100)) {
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) continue;
    const message = parsed.data;
    const runId = message.__openclaw?.runId ?? message.runId;
    if (Array.isArray(message.content))
      for (const block of message.content) {
        const call = callSchema.safeParse(block);
        if (call.success && allowed.has(call.data.name))
          tools.set(call.data.id, {
            id: `${runId ?? 'history'}:${call.data.id}`,
            name: call.data.name,
            status: 'running',
            parameters: bounded(call.data.arguments, 4096),
            output: '',
          });
      }
    if (
      message.role === 'toolResult' &&
      message.toolCallId &&
      message.toolName &&
      allowed.has(message.toolName)
    ) {
      const existing = tools.get(message.toolCallId);
      const content = Array.isArray(message.content)
        ? message.content
            .map((block: unknown) =>
              z.object({ text: z.string() }).safeParse(block),
            )
            .filter((block) => block.success)
            .map((block) => block.data.text)
            .join('\n')
        : message.content;
      tools.set(message.toolCallId, {
        id: existing?.id ?? `${runId ?? 'history'}:${message.toolCallId}`,
        name: message.toolName,
        status: message.isError ? 'failed' : 'completed',
        parameters: existing?.parameters ?? '',
        output: projectToolText(content),
      });
    }
  }
  return [...tools.values()].slice(-100);
}
