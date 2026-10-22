import type {
  Attachment,
  CreateChatRequest,
  ManagerCommand,
  ManagerResultData,
} from '@messenger/contracts';
import { ConflictError } from '../../../backend/src/errors.js';
import { enqueue } from '../../../backend/src/chats/queue.js';
import { summary } from '../../../backend/src/chats/service-record.js';
import type { ChatRecord, Store } from '../../../backend/src/storage/store.js';
import type { ManagerAuthorization } from './authorization.js';

export function storedAcceptance(
  store: Store,
  id: string,
): ManagerResultData | undefined {
  const row = store.db
    .prepare('SELECT json FROM manager_results WHERE id = ?')
    .get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as ManagerResultData) : undefined;
}
function saveAcceptance(
  store: Store,
  id: string,
  data: ManagerResultData,
): ManagerResultData {
  store.db
    .prepare('INSERT OR IGNORE INTO manager_results VALUES (?, ?)')
    .run(id, JSON.stringify(data));
  return data;
}

export function acceptMessage(
  store: Store,
  command: Extract<ManagerCommand, { type: 'conversation.message.send' }>,
  attachments: Attachment[],
): ManagerResultData {
  const previous = store.commandRequest(command.commandId);
  if (previous && previous !== JSON.stringify(command))
    throw new ConflictError(
      'COMMAND_ID_REUSED',
      'This command identity was already used with different values.',
    );
  const stored = store.getCommand(command.commandId);
  if (stored) {
    if (!stored.ok)
      throw new ConflictError(stored.error.code, stored.error.detail);
    return storedAcceptance(store, command.commandId) ?? stored.data;
  }
  const chat = store.getChat(command.chatId);
  if (chat.status === 'deleting')
    throw new ConflictError('CHAT_DELETING', 'This chat is being deleted.');
  const operation = store.settingsOperation(chat.id);
  if (
    operation?.status === 'applying' ||
    operation?.status === 'unknown' ||
    operation?.policy === 'cancel-work'
  )
    throw new ConflictError(
      'SETTINGS_APPLYING',
      'Wait for this chat’s settings transition to finish.',
    );
  const item = enqueue(store, command, attachments);
  return saveAcceptance(store, command.commandId, {
    messageId: item.id,
    receipt: {
      commandId: command.commandId,
      acceptedAt: item.createdAt,
      state: 'accepted',
      messageId: item.id,
      submissionId: item.submissionId,
    },
  });
}
export function acceptCreation(
  store: Store,
  authorization: ManagerAuthorization,
  accountId: string,
  input: CreateChatRequest,
  attachments: Attachment[],
): ManagerResultData {
  const previous = store.creationCommand(input.commandId);
  if (previous) {
    if (previous.deleted)
      throw new ConflictError(
        'CHAT_DELETED',
        'This chat was deleted. Create a new chat with a new command identity.',
      );
    if (previous.input !== JSON.stringify(input))
      throw new ConflictError(
        'COMMAND_ID_REUSED',
        'This command identity was already used with different values.',
      );
    return (
      storedAcceptance(store, input.commandId) ?? {
        chat: summary(store.getChat(previous.chatId)),
      }
    );
  }
  const now = Date.now();
  const chat: ChatRecord = {
    id: crypto.randomUUID(),
    name: input.name ?? 'New chat',
    status: 'creating',
    version: 1,
    createdAt: now,
    updatedAt: now,
    unread: false,
    settings: input.settings,
    agentId: null,
    sessionKey: null,
    creationId: input.commandId,
  };
  store.db.transaction(() => {
    store.reserveChat(chat);
    store.saveCreationCommand(input.commandId, chat.id, input);
    store.saveMetadata(chat.id, {
      manualName: input.name !== undefined,
      creationInput: input,
    });
    authorization.claim('chat', chat.id, accountId);
    store.saveCommand({
      type: 'command.result',
      commandId: input.commandId,
      ok: true,
      data: {},
    });
    if (
      input.initialMessage &&
      (input.initialMessage.text.trim() || attachments.length)
    ) {
      const id = crypto.randomUUID();
      enqueue(
        store,
        {
          type: 'conversation.message.send',
          commandId: id,
          chatId: chat.id,
          text: input.initialMessage.text,
        },
        attachments,
      );
      authorization.claim('command', id, accountId, chat.id);
    }
  })();
  return saveAcceptance(store, input.commandId, {
    chat: summary(chat),
    receipt: { commandId: input.commandId, acceptedAt: now, state: 'accepted' },
  });
}
