import type {
  Attachment,
  ChatSettings,
  ChatSnapshot,
  ConversationCommand,
  ConversationResult,
  PendingMessage,
  Preferences,
} from '@messenger/contracts';
import type { Store } from '../storage/store.js';
import type { Gateway, GatewayHistory } from '../gateway/types.js';
import {
  ConflictError,
  GatewayUnavailableError,
  NotFoundError,
} from '../errors.js';
import { mapping } from './service-record.js';
import { historyWithReceipts } from './history.js';
import { boundedRun } from './projection.js';
import { abortAcceptedInputs } from './cancellations.js';
import { editable, enqueue, requireContent, reconcileInputs } from './queue.js';
export interface CommandContext {
  store: Store;
  gateway: Gateway;
  streams: Map<string, NonNullable<ChatSnapshot['activeRun']>>;
  snapshot(id: string): Promise<ChatSnapshot>;
  pending(id: string): PendingMessage[];
  claimSubmission(item: PendingMessage): void;
  locallyUninvoked?: (item: PendingMessage) => boolean;
  invalidateUninvoked(chatId: string): void;
  projectHistory(id: string, history: GatewayHistory): GatewayHistory;
  preferences(): Preferences;
  changed(id: string, affectsExecution?: boolean): void;
  autoTitle(id: string, text: string): void;
  startSteer(id: string, item: PendingMessage): void;
  prepareMessage(
    settings: ChatSettings,
    ids?: string[],
    chatId?: string,
  ): Promise<Attachment[]>;
}
export async function executeCommand(
  ctx: CommandContext,
  command: ConversationCommand,
): Promise<Extract<ConversationResult, { ok: true }>['data']> {
  if (command.type === 'conversation.snapshot.request')
    return command.chatId
      ? { snapshot: await ctx.snapshot(command.chatId) }
      : {
          snapshots: await Promise.all(
            ctx.store.listChats().map((chat) => ctx.snapshot(chat.id)),
          ),
        };
  const chat = ctx.store.getChat(command.chatId);
  if (command.type === 'conversation.message.read') {
    chat.unread = false;
    ctx.store.saveChat(chat);
    ctx.changed(chat.id, false);
    return {};
  }
  if (command.type === 'conversation.history.request') {
    const history = await ctx.gateway.history(
      mapping(chat),
      command.cursor ? { cursor: command.cursor } : {},
    );
    return {
      messages: history.messages,
      historyCursor: history.historyCursor,
      hasOlderHistory: history.hasOlderHistory,
    };
  }
  if (chat.status === 'deleting' || chat.status === 'creating' || !chat.agentId)
    throw new ConflictError(
      'CHAT_UNAVAILABLE',
      'Wait for this chat to become available.',
    );
  const operation = ctx.store.settingsOperation(chat.id);
  if (
    operation?.status === 'applying' ||
    operation?.status === 'unknown' ||
    (operation?.policy === 'cancel-work' && operation.status === 'pending')
  )
    throw new ConflictError(
      'SETTINGS_APPLYING',
      'Wait for this chat’s settings transition to finish.',
    );
  if (command.type === 'conversation.run.abort') {
    ctx.invalidateUninvoked(chat.id);
    await abortAcceptedInputs(ctx.store, ctx.gateway, chat);
    const history = ctx.projectHistory(
      chat.id,
      await historyWithReceipts(
        ctx.gateway,
        mapping(chat),
        ctx
          .pending(chat.id)
          .filter((item) => item.state !== 'pending')
          .map((item) => item.submissionId),
      ),
    );
    reconcileInputs(
      ctx.store,
      chat.id,
      history,
      ctx.locallyUninvoked,
      !ctx.gateway.nativeAbortProofs,
    );
    if (history.activeRun) {
      const preview = boundedRun(history.activeRun);
      if (preview) ctx.streams.set(chat.id, preview);
    } else ctx.streams.delete(chat.id);
    chat.status = ctx.pending(chat.id).some((item) => item.state === 'unknown')
      ? 'recovery'
      : history.activeRun
        ? 'running'
        : 'idle';
    ctx.store.saveChat(chat);
    ctx.changed(chat.id);
    return {};
  }
  if (command.type === 'conversation.message.resolveUnknown') {
    const item = ctx
      .pending(chat.id)
      .find((candidate) => candidate.id === command.messageId);
    if (!item) throw new NotFoundError();
    if (item.state !== 'unknown' || item.revision !== command.revision)
      throw new ConflictError(
        'RECOVERY_CHANGED',
        'This message recovery state changed. Reload before continuing.',
      );
    const history = ctx.projectHistory(
      chat.id,
      await ctx.gateway.history(mapping(chat), {
        inputRunIds: [item.submissionId],
      }),
    );
    reconcileInputs(ctx.store, chat.id, history, ctx.locallyUninvoked);
    if (
      ctx
        .pending(chat.id)
        .some(
          (candidate) =>
            candidate.id === item.id && candidate.state === 'unknown',
        )
    ) {
      if (command.action === 'discard') ctx.store.removePending(item.id);
      else {
        const sessionId = ctx.store.submissionScope(item.id);
        if (!sessionId || history.sessionId !== sessionId)
          throw new ConflictError(
            'RECOVERY_REQUIRES_NEW_SUBMISSION',
            'The original session cannot be confirmed. Check the conversation, then discard this item and explicitly send a new message if needed.',
          );
        item.state = 'pending';
        item.revision += 1;
        ctx.store.savePending(item);
      }
    }
    chat.status = ctx
      .pending(chat.id)
      .some((entry) => entry.state === 'unknown')
      ? 'recovery'
      : history.activeRun
        ? 'running'
        : 'idle';
    ctx.store.saveChat(chat);
    ctx.changed(chat.id);
    return {};
  }
  if (command.type === 'conversation.message.send') {
    const attachments = await ctx.prepareMessage(
      chat.settings,
      command.uploadIds,
      chat.id,
    );
    const item = enqueue(ctx.store, command, attachments);
    if (
      (command.behavior ?? ctx.preferences().busySendBehavior) === 'steer' &&
      ctx.streams.has(chat.id) &&
      ctx.gateway.ready
    )
      ctx.claimSubmission(item);
    ctx.store.savePending(item);
    ctx.autoTitle(chat.id, item.text);
    ctx.changed(chat.id);
    if (item.state === 'submitting') ctx.startSteer(chat.id, item);
    return { messageId: item.id };
  }
  const item = editable(
    ctx.store,
    chat.id,
    command.messageId,
    command.revision,
  );
  if (command.type === 'conversation.message.editQueued') {
    const attachments =
      command.uploadIds === undefined
        ? item.attachments
        : await ctx.prepareMessage(chat.settings, command.uploadIds, chat.id);
    requireContent(
      command.text,
      attachments.map((attachment) => attachment.uploadId),
    );
    item.text = command.text;
    item.attachments = attachments;
    item.revision += 1;
    ctx.store.savePending(item);
  } else if (command.type === 'conversation.message.cancelQueued')
    ctx.store.removePending(item.id);
  else {
    if (!ctx.streams.has(chat.id))
      throw new ConflictError(
        'NO_ACTIVE_RUN',
        'There is no active run to steer.',
      );
    if (!ctx.gateway.ready) throw new GatewayUnavailableError();
    ctx.claimSubmission(item);
    ctx.store.savePending(item);
    ctx.startSteer(chat.id, item);
  }
  ctx.changed(chat.id);
  return { messageId: item.id };
}
