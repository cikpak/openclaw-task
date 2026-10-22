import type { ManagerCommand, ManagerResultData } from '@messenger/contracts';
import { NotFoundError } from '../../../backend/src/errors.js';
import { readPreferences } from '../../../backend/src/chats/preferences.js';
import { summary } from '../../../backend/src/chats/service-record.js';
import type { Store } from '../../../backend/src/storage/store.js';
import type { ManagerAuthorization } from './authorization.js';
import { cachedSnapshot, recentMessages } from './cached.js';
import { storedAcceptance } from './acceptance.js';
import type { ManagerEngine } from './types.js';

export class CachedCommands {
  constructor(
    private readonly store: Store,
    private readonly authorization: ManagerAuthorization,
    private readonly engine: ManagerEngine | undefined,
  ) {}
  private chats(accountId: string) {
    return this.store
      .listChats()
      .filter((chat) => this.authorization.owns('chat', chat.id, accountId));
  }
  read(
    command: ManagerCommand,
    accountId: string,
  ): ManagerResultData | undefined {
    const { store } = this;
    if (
      command.type === 'chat.list' ||
      command.type === 'application.bootstrap.request'
    )
      return {
        chats: this.chats(accountId).map(summary),
        ...(command.type === 'application.bootstrap.request'
          ? { preferences: readPreferences(store) }
          : {}),
      };
    if (command.type === 'preferences.get')
      return { preferences: readPreferences(store) };
    if (command.type === 'chat.get')
      return { chat: summary(store.getChat(command.chatId)) };
    if (command.type === 'chat.settings.get') {
      const chat = store.getChat(command.chatId);
      return {
        settings: {
          effective: chat.settings,
          pending: store.settingsOperation(chat.id),
          version: chat.version,
        },
      };
    }
    if (command.type === 'conversation.snapshot.request')
      return command.chatId
        ? { snapshot: this.snapshot(command.chatId) }
        : {
            snapshots: this.chats(accountId).map((chat) =>
              this.snapshot(chat.id),
            ),
          };
    if (command.type === 'conversation.recent.request') {
      const snapshot = this.snapshot(command.chatId);
      const messages = recentMessages(snapshot.messages, command.viewport);
      return {
        snapshot: {
          ...snapshot,
          messages,
          hasOlderHistory:
            snapshot.hasOlderHistory ||
            messages.length < snapshot.messages.length,
        },
      };
    }
    if (command.type === 'command.receipt.request') {
      const accepted = storedAcceptance(store, command.receiptCommandId);
      const result = store.getCommand(command.receiptCommandId);
      const row = store.db
        .prepare('SELECT created_at FROM command_results WHERE id = ?')
        .get(command.receiptCommandId) as { created_at: number } | undefined;
      if (!result?.ok || !row) throw new NotFoundError();
      const pending = this.chats(accountId)
        .flatMap((chat) => store.pending(chat.id))
        .find((item) => item.id === result.data.messageId);
      const creating =
        accepted?.chat && store.getChat(accepted.chat.id).status === 'creating';
      return {
        receipt: {
          commandId: command.receiptCommandId,
          acceptedAt: row.created_at,
          state:
            pending?.state === 'unknown'
              ? 'unknown'
              : pending?.state === 'submitting'
                ? 'dispatching'
                : pending?.state === 'submitted'
                  ? 'submitted'
                  : pending || creating
                    ? 'accepted'
                    : 'completed',
          messageId: accepted?.messageId ?? result.data.messageId,
          submissionId: pending?.submissionId,
        },
      };
    }
    return undefined;
  }
  private snapshot(id: string) {
    return (
      this.engine?.service.cachedSnapshot(id) ?? cachedSnapshot(this.store, id)
    );
  }
}
