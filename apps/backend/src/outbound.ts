import type {
  ConversationEvent,
  ConversationFrame,
} from '@messenger/contracts';
import { OutboundContractError } from './errors.js';
import { eventSchema, outboundFrameSchema } from './schemas.js';
export function parseOutboundEvent(value: unknown): ConversationEvent {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw new OutboundContractError();
  return parsed.data;
}
export function parseOutboundFrame(value: unknown): ConversationFrame {
  const parsed = outboundFrameSchema.safeParse(value);
  if (!parsed.success) throw new OutboundContractError();
  return parsed.data;
}
