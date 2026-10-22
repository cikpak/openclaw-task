import { z } from 'zod';
import { GatewayUnavailableError } from '../errors.js';
import type { GatewayContext } from './context.js';
import type { GatewayMapping } from './types.js';
import { upstreamMessageSchema } from './protocol-schemas.js';
/** Native display caps must never silently become canonical message retention. */
export async function completeMessages(
  context: GatewayContext,
  mapping: GatewayMapping,
  values: unknown[],
): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const value of values) {
    const parsed = upstreamMessageSchema.safeParse(value);
    if (
      !parsed.success ||
      !['user', 'assistant'].includes(parsed.data.role ?? '') ||
      !parsed.data.__openclaw?.truncated
    ) {
      result.push(value);
      continue;
    }
    const id =
      parsed.data.__openclaw.id ?? parsed.data.id ?? parsed.data.messageId;
    if (!id) throw new GatewayUnavailableError();
    let message: ReturnType<typeof upstreamMessageSchema.safeParse> | null =
      null;
    try {
      const fetched = z
        .object({ ok: z.boolean(), message: z.unknown().optional() })
        .parse(
          await context.request('chat.message.get', {
            sessionKey: mapping.sessionKey,
            agentId: mapping.agentId,
            messageId: id,
            maxChars: 2000000,
          }),
        );
      message = fetched.ok
        ? upstreamMessageSchema.safeParse(fetched.message)
        : null;
    } catch {
      // Native JSON/frame limits can reject even a bounded character count
      // (for example heavily escaped text). Exact-scope helper validation still
      // decides visibility; transport rejection must not become retention.
      if (!context.fullMessage) throw new GatewayUnavailableError();
    }
    if (!message?.success || message.data.__openclaw?.truncated) {
      if (!context.fullMessage) throw new GatewayUnavailableError();
      message = upstreamMessageSchema.safeParse(
        await context.fullMessage(mapping, id),
      );
    }
    if (
      !message?.success ||
      message.data.__openclaw?.truncated ||
      message.data.role !== parsed.data.role ||
      (message.data.__openclaw?.id ??
        message.data.id ??
        message.data.messageId) !== id
    )
      throw new GatewayUnavailableError();
    result.push({
      ...message.data,
      __openclaw: {
        ...message.data.__openclaw,
        ...parsed.data.__openclaw,
        truncated: false,
      },
    });
  }
  return result;
}
