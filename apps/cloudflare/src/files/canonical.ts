import type { ChatSettings, ManagerCommand } from '@messenger/contracts';
import { ValidationError } from '../../../backend/src/errors.js';
import { readPreferences } from '../../../backend/src/chats/preferences.js';
import type { Store } from '../../../backend/src/storage/store.js';

type Projection = { project<T>(value: T): T };
const placeholder = /\[(?:private reference|redacted)\]/u;
function restoreText(
  submitted: string,
  original: string | undefined,
  projection: Projection,
): string {
  if (original !== undefined && submitted === projection.project(original))
    return original;
  if (placeholder.test(submitted))
    throw new ValidationError(
      'Private content is hidden. Replace the entire hidden value before editing it.',
    );
  return submitted;
}
function settings(
  submitted: ChatSettings,
  original: ChatSettings,
  projection: Projection,
): ChatSettings {
  return Object.fromEntries(
    Object.entries(submitted).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? restoreText(
            value,
            original[key as keyof ChatSettings] as string | undefined,
            projection,
          )
        : value,
    ]),
  ) as unknown as ChatSettings;
}

/** Preserve canonical values that an unchanged browser projection cannot express. */
export function restoreCanonicalCommand(
  command: ManagerCommand,
  store: Store,
  projection: Projection,
): ManagerCommand {
  // Only replacement operations need canonical restoration; other commands pass through.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (command.type) {
    case 'chat.settings.update':
      return {
        ...command,
        settings: settings(
          command.settings,
          store.getChat(command.chatId).settings,
          projection,
        ),
      };
    case 'preferences.update':
      return {
        ...command,
        preferences: {
          ...command.preferences,
          defaults: settings(
            command.preferences.defaults,
            readPreferences(store).defaults,
            projection,
          ),
        },
      };
    case 'chat.create':
      return {
        ...command,
        settings: settings(
          command.settings,
          readPreferences(store).defaults,
          projection,
        ),
      };
    case 'chat.rename':
      return {
        ...command,
        name: restoreText(
          command.name,
          store.getChat(command.chatId).name,
          projection,
        ),
      };
    case 'conversation.message.editQueued': {
      const previous = store
        .pending(command.chatId)
        .find((item) => item.id === command.messageId);
      return {
        ...command,
        text: restoreText(command.text, previous?.text, projection),
      };
    }
    default:
      return command;
  }
}
