import { z } from 'zod';
import type { Message } from '@messenger/contracts';
import { upstreamMessageSchema } from './protocol-schemas.js';
import { projectToolText } from './tools.js';
export function messageText(value: unknown): string {
  const p = upstreamMessageSchema.safeParse(value);
  if (!p.success) return '';
  const content = p.data.content;
  const text =
    typeof content === 'string'
      ? content
      : (content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('') ?? '');
  return p.data.role === 'tool' || p.data.role === 'toolResult'
    ? projectToolText(text)
    : text;
}
export function canonicalModel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
export function projectMessage(value: unknown, index: number): Message | null {
  const p = upstreamMessageSchema.safeParse(value);
  if (!p.success) return null;
  const role = p.data.role;
  if (
    role !== 'user' &&
    role !== 'assistant' &&
    role !== 'tool' &&
    role !== 'toolResult'
  )
    return null;
  const runId = p.data.__openclaw?.runId ?? p.data.runId;
  const toolName = z
    .enum(['read', 'write', 'edit', 'web_fetch'])
    .safeParse(p.data.toolName);
  return {
    id:
      p.data.__openclaw?.id ??
      p.data.id ??
      p.data.messageId ??
      (p.data.__openclaw?.seq !== undefined
        ? `history-seq-${p.data.__openclaw.seq}`
        : `history-${index}`),
    role: role === 'toolResult' ? 'tool' : role,
    text: messageText(value),
    ...(role === 'assistant' && p.data.stopReason === 'error'
      ? { requestFailed: true }
      : {}),
    ...(runId ? { runId } : {}),
    ...((role === 'tool' || role === 'toolResult') && p.data.toolCallId
      ? { toolCallId: p.data.toolCallId }
      : {}),
    ...((role === 'tool' || role === 'toolResult') && toolName.success
      ? { toolName: toolName.data }
      : {}),
    ...(p.data.__openclaw?.seq !== undefined
      ? { historySequence: p.data.__openclaw.seq }
      : {}),
    createdAt:
      typeof p.data.timestamp === 'number'
        ? p.data.timestamp
        : p.data.timestamp
          ? Date.parse(p.data.timestamp) || 0
          : (p.data.__openclaw?.recordTimestampMs ?? 0),
  };
}
