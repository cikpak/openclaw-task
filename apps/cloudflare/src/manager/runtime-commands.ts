import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import {
  NotFoundError,
  ApplicationError,
} from '../../../backend/src/errors.js';
import { mapping } from '../../../backend/src/chats/service-record.js';
import type { Store } from '../../../backend/src/storage/store.js';
import type { ManagerEngine } from './types.js';

export async function runtimeCommand(
  command: ManagerCommand,
  store: Store,
  engine: ManagerEngine,
): Promise<ManagerResultData> {
  const { service, gateway } = engine;
  const version = 'version' in command ? `"${command.version}"` : undefined;

  if (command.type === 'chat.rename') {
    return {
      chat: await service.rename(command.chatId, command.name, version),
    };
  }
  if (command.type === 'chat.delete') {
    await service.delete(command.chatId, version);
    return { status: 'deleting' };
  }
  if (command.type === 'chat.recover') {
    return { chat: await service.recoverChat(command.chatId, version) };
  }
  if (command.type === 'chat.settings.update') {
    return {
      settingsOperation: await service.updateSettings(
        command.chatId,
        command.settings,
        command.policy,
        version,
      ),
    };
  }
  if (command.type === 'chat.settings.resolve') {
    return {
      settings: await service.resolveSettings(
        command.chatId,
        command.action,
        version,
      ),
    };
  }
  if (command.type === 'preferences.update') {
    return {
      preferences: await service.updatePreferences(
        command.preferences,
        version,
      ),
    };
  }
  if (command.type === 'models.list') {
    return {
      models: await gateway.models(
        command.chatId ? mapping(store.getChat(command.chatId)) : undefined,
      ),
    };
  }
  if (!command.type.startsWith('conversation.')) throw new NotFoundError();
  const result = await service.command(
    command as Parameters<typeof service.command>[0],
  );
  if (!result.ok) {
    throw new ApplicationError(
      result.error.status,
      result.error.code,
      result.error.detail,
    );
  }
  return result.data;
}
