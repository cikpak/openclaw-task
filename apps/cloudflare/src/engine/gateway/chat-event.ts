import { chatEventSchema } from '../../../../backend/src/gateway/protocol-schemas.js';
import { messageText } from '../../../../backend/src/gateway/messages.js';
import type { GatewayEvent } from '../../../../backend/src/gateway/types.js';
export function nativeChatEvent(frame: {
  event: string;
  payload?: unknown;
}): GatewayEvent | null {
  if (frame.event !== 'chat') return null;
  const parsed = chatEventSchema.safeParse(frame.payload);
  if (!parsed.success) return null;
  const event = parsed.data;
  return {
    type: 'chat',
    sessionKey: event.sessionKey,
    runId: event.runId,
    sequence: event.seq,
    state: event.state,
    text:
      event.state === 'error'
        ? 'The request failed. Try again.'
        : (event.deltaText ?? messageText(event.message)),
    replace: event.replace ?? event.deltaText === undefined,
  };
}
