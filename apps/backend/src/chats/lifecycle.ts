import type {
  ChatSnapshot,
  ConversationEvent,
  SettingsOperation,
} from '@messenger/contracts';
import type { ChatRecord, Store } from '../storage/store.js';
import type { Gateway, GatewayHistory } from '../gateway/types.js';
import { ConflictError } from '../errors.js';
import { mapping } from './service-record.js';
import { reconcileInputs } from './queue.js';
import { historyWithReceipts } from './history.js';
export interface LifecycleContext {
  store: Store;
  gateway: Gateway;
  readonly closed: boolean;
  streams: Map<string, NonNullable<ChatSnapshot['activeRun']>>;
  projectHistory(id: string, history: GatewayHistory): GatewayHistory;
  changed(id: string): void;
  publish(
    event: Omit<
      Extract<ConversationEvent, { type: 'conversation.deleted' }>,
      'generation' | 'sequence'
    >,
  ): void;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
}
export async function completeDeletion(
  ctx: LifecycleContext,
  chat: ChatRecord,
): Promise<void> {
  try {
    if (!chat.agentId) {
      if (!ctx.gateway.lookupCreation) return;
      const found = await ctx.gateway.lookupCreation(chat.id);
      if (!found) {
        if (ctx.closed) return;
        ctx.store.saveTombstone(chat);
        ctx.store.removeChat(chat.id);
        ctx.streams.delete(chat.id);
        ctx.publish({ type: 'conversation.deleted', chatId: chat.id });
        return;
      }
      chat.agentId = found.agentId;
      chat.sessionKey = found.sessionKey;
      ctx.store.saveChat(chat);
    }
    if (!ctx.gateway.exists || (await ctx.gateway.exists(mapping(chat)))) {
      try {
        await ctx.gateway.abort(mapping(chat));
      } catch {
        /* Agent deletion also fences work; an uninitialized session may not support abort. */
      }
      await ctx.gateway.remove(mapping(chat));
    }
    if (ctx.closed) return;
    ctx.store.removeChat(chat.id);
    ctx.streams.delete(chat.id);
    ctx.publish({ type: 'conversation.deleted', chatId: chat.id });
  } catch {
    /* Retain the deleting reservation until authoritative confirmation. */
  }
}
export async function applySettings(
  ctx: LifecycleContext,
  chat: ChatRecord,
  operation: SettingsOperation,
): Promise<void> {
  try {
    if (operation.policy === 'cancel-work') {
      for (const item of ctx.store.pending(chat.id))
        if (item.state === 'pending') ctx.store.removePending(item.id);
      await ctx.gateway.abort(mapping(chat));
      const history = ctx.projectHistory(
        chat.id,
        await historyWithReceipts(
          ctx.gateway,
          mapping(chat),
          ctx.store.pending(chat.id).map((item) => item.submissionId),
        ),
      );
      reconcileInputs(ctx.store, chat.id, history);
      if (history.activeRun || ctx.store.pending(chat.id).length)
        throw new ConflictError(
          'WORK_CANCELLATION_PENDING',
          'Waiting for cancellation to be confirmed.',
        );
      ctx.streams.delete(chat.id);
    }
    const effective = await ctx.gateway.settings(
      mapping(chat),
      operation.settings,
    );
    if (ctx.closed) return;
    await ctx.withLock(chat.id, () => {
      const current = ctx.store.getChat(chat.id);
      if (
        current.status === 'deleting' ||
        ctx.store.settingsOperation(chat.id)?.id !== operation.id
      )
        return Promise.resolve();
      current.settings = effective;
      current.version += 1;
      current.status = 'idle';
      ctx.store.saveChat(current);
      ctx.store.saveSettingsOperation(chat.id, null);
      ctx.changed(chat.id);
      return Promise.resolve();
    });
  } catch {
    if (ctx.closed) return;
    if (ctx.store.settingsOperation(chat.id)?.id === operation.id) {
      operation.status = 'unknown';
      ctx.store.saveSettingsOperation(chat.id, operation);
      ctx.changed(chat.id);
    }
  }
}
