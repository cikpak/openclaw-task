import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import type { Store } from '../../../backend/src/storage/store.js';
import type { ChatService } from '../../../backend/src/chats/service.js';
import {
  readPreferences,
  savePreferences,
} from '../../../backend/src/chats/preferences.js';

export async function cacheOnlyCommand(
  command: ManagerCommand,
  store: Store,
  service: ChatService,
): Promise<ManagerResultData | undefined> {
  const version = 'version' in command ? `"${command.version}"` : undefined;
  if (command.type === 'chat.rename')
    return {
      chat: await service.rename(command.chatId, command.name, version),
    };
  if (
    command.type === 'preferences.update' &&
    JSON.stringify(command.preferences.defaults) ===
      JSON.stringify(readPreferences(store).defaults)
  )
    return {
      preferences: savePreferences(store, command.preferences, version),
    };
  return undefined;
}
