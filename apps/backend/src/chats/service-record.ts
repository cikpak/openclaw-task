import type { ChatSummary } from '@messenger/contracts';
import { ConflictError } from '../errors.js';
import type { GatewayMapping } from '../gateway/types.js';
import { chatSchema } from '../schemas.js';
import type { ChatRecord } from '../storage/store.js';

export function summary(chat: ChatRecord): ChatSummary {
  return chatSchema.parse(chat);
}
export function mapping(chat: ChatRecord): GatewayMapping {
  if (!chat.agentId || !chat.sessionKey)
    throw new ConflictError(
      'CHAT_INITIALIZING',
      'This chat is still initializing.',
    );
  return { agentId: chat.agentId, sessionKey: chat.sessionKey };
}
