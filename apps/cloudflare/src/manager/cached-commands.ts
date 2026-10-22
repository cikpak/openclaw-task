import { rememberViewport, pruneCachedSnapshot } from './cached-window.js';
import { markCachedRead } from './cached-read.js';
import { modelCache } from './cached-models.js';
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
    if (command.type === 'conversation.message.read')
      return markCachedRead(store, command.commandId, command.chatId);
    if (command.type === 'models.list' && command.cachedOnly)
      return { models: modelCache(store).read(command.chatId) };
    if (
      command.type === 'conversation.history.request' &&
      command.cursor?.startsWith('cache:')
    ) {
      const snapshot = this.snapshot(command.chatId);
      const index = snapshot.messages.findIndex(
        (message) => message.id === command.cursor!.slice(6),
      );
      if (index < 0) throw new NotFoundError();
      return {
        messages: snapshot.messages.slice(0, index),
        historyCursor: snapshot.historyCursor,
        hasOlderHistory: snapshot.hasOlderHistory,
      };
    }
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
      rememberViewport(store, command.chatId, command.viewport);
      const snapshot = pruneCachedSnapshot(
        store,
        this.snapshot(command.chatId),
      );
      const cached = store.db
        .prepare('SELECT chat_id FROM chat_history WHERE chat_id = ?')
        .get(command.chatId);
      if (cached)
        store.db
          .prepare('UPDATE chat_history SET json = ? WHERE chat_id = ?')
          .run(JSON.stringify(snapshot), command.chatId);
      const messages = recentMessages(snapshot.messages, command.viewport);
      return {
        snapshot: {
          ...snapshot,
          messages,
          historyCursor:
            messages.length < snapshot.messages.length && messages[0]
              ? `cache:${messages[0].id}`
              : snapshot.historyCursor,
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
