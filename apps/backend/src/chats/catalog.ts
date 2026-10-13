import { randomUUID } from 'node:crypto';
import type {
  Attachment,
  ChatSettings,
  ChatSummary,
  CreateChatRequest,
  PendingMessage,
  SettingsOperation,
} from '@messenger/contracts';
import type { Store, ChatRecord } from '../database.js';
import type { Gateway, GatewayMapping } from '../gateway/types.js';
import { ConflictError, GatewayUnavailableError } from '../errors.js';
import { createChatSchema } from '../schemas.js';
import { mapping, summary } from './service.js';
import { enqueue, requireContent, requireVersion } from './queue.js';
export interface CatalogContext {
  store: Store;
  gateway: Gateway;
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  validateSettings(
    settings: ChatSettings,
    target?: GatewayMapping,
  ): Promise<void>;
  prepareMessage(
    settings: ChatSettings,
    ids?: string[],
    chatId?: string,
  ): Promise<Attachment[]>;
  refresh(id: string): Promise<void>;
  schedule(id: string): void;
  changed(id: string, affectsExecution?: boolean): void;
  pending(id: string): PendingMessage[];
}
export async function createChat(
  ctx: CatalogContext,
  input: CreateChatRequest,
): Promise<ChatSummary> {
  return ctx.withLock(`creation:${input.commandId}`, async () => {
    const identity = ctx.store.creationCommand(input.commandId);
    if (
      identity &&
      identity.input !== 'null' &&
      JSON.stringify(
        createChatSchema.parse(JSON.parse(identity.input) as unknown),
      ) !== JSON.stringify(createChatSchema.parse(input))
    )
      throw new ConflictError(
        'COMMAND_ID_REUSED',
        'This command identity was already used with different values.',
      );
    if (identity?.deleted)
      throw new ConflictError(
        'CHAT_DELETED',
        'This chat was deleted. Create a new chat with a new command identity.',
      );
    const existing = ctx.store.findCreation(input.commandId);
    if (existing) {
      const saved = ctx.store.metadata(existing.id).creationInput;
      if (
        saved &&
        JSON.stringify(createChatSchema.parse(saved)) !==
          JSON.stringify(createChatSchema.parse(input))
      )
        throw new ConflictError(
          'COMMAND_ID_REUSED',
          'This command identity was already used with different values.',
        );
      if (
        existing.status === 'recovery' &&
        !existing.agentId &&
        ctx.gateway.recoverCreation
      ) {
        const recovered = await ctx.gateway.recoverCreation(
          existing.id,
          existing.settings,
        );
        const created =
          recovered ??
          (await ctx.gateway.create(existing.id, existing.settings));
        if (ctx.store.creationCommand(input.commandId)?.deleted)
          throw new ConflictError(
            'CHAT_DELETED',
            'This chat was deleted while it was recovering.',
          );
        const current = ctx.store.getChat(existing.id);
        current.agentId = created.agentId;
        current.sessionKey = created.sessionKey;
        ctx.store.saveChat(current);
        await ctx.refresh(existing.id);
        ctx.schedule(existing.id);
      }
      return summary(ctx.store.getChat(existing.id));
    }
    await ctx.validateSettings(input.settings);
    const attachments = await ctx.prepareMessage(
      input.settings,
      input.initialMessage?.uploadIds,
    );
    if (
      input.initialMessage &&
      (input.initialMessage.text.trim() ||
        input.initialMessage.uploadIds?.length)
    )
      requireContent(input.initialMessage.text, input.initialMessage.uploadIds);
    const now = Date.now();
    const chat: ChatRecord = {
      id: randomUUID(),
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
    ctx.store.db.transaction(() => {
      ctx.store.reserveChat(chat);
      ctx.store.saveCreationCommand(
        input.commandId,
        chat.id,
        createChatSchema.parse(input),
      );
      ctx.store.saveMetadata(chat.id, {
        manualName: input.name !== undefined,
        creationInput: createChatSchema.parse(input),
      });
      if (
        input.initialMessage &&
        (input.initialMessage.text.trim() || attachments.length)
      )
        enqueue(
          ctx.store,
          {
            type: 'conversation.message.send',
            commandId: randomUUID(),
            chatId: chat.id,
            text: input.initialMessage.text,
          },
          attachments,
        );
    })();
    try {
      const created = await ctx.gateway.create(chat.id, input.settings);
      const current = ctx.store.getChat(chat.id);
      current.agentId = created.agentId;
      current.sessionKey = created.sessionKey;
      ctx.store.saveChat(current);
      await ctx.refresh(chat.id);
    } catch {
      if (!ctx.store.listChats().some((candidate) => candidate.id === chat.id))
        throw new ConflictError(
          'CHAT_DELETED',
          'This chat was deleted while it was initializing.',
        );
      const current = ctx.store.getChat(chat.id);
      if (current.status !== 'deleting') current.status = 'recovery';
      ctx.store.saveChat(current);
      throw new GatewayUnavailableError();
    }
    ctx.changed(chat.id);
    ctx.schedule(chat.id);
    return summary(ctx.store.getChat(chat.id));
  });
}
export async function renameChat(
  ctx: CatalogContext,
  id: string,
  name: string,
  version?: string,
): Promise<ChatSummary> {
  return ctx.withLock(id, () => {
    const chat = ctx.store.getChat(id);
    requireVersion(chat.version, version);
    if (chat.status === 'deleting')
      throw new ConflictError('CHAT_DELETING', 'This chat is being deleted.');
    chat.name = name;
    chat.version += 1;
    ctx.store.saveMetadata(id, {
      ...ctx.store.metadata(id),
      manualName: true,
    });
    ctx.store.saveChat(chat);
    ctx.changed(id, false);
    return Promise.resolve(summary(chat));
  });
}
export async function recoverChat(
  ctx: CatalogContext,
  id: string,
  version?: string,
): Promise<ChatSummary> {
  const chat = ctx.store.getChat(id);
  requireVersion(chat.version, version);
  if (chat.status === 'deleting')
    throw new ConflictError('CHAT_DELETING', 'This chat is being deleted.');
  if (chat.agentId && chat.sessionKey)
    throw new ConflictError(
      'USE_MESSAGE_RECOVERY',
      'The chat exists. Resolve any uncertain messages individually.',
    );
  const saved = createChatSchema.safeParse(
    ctx.store.metadata(id).creationInput,
  );
  const input = saved.success
    ? saved.data
    : { commandId: chat.creationId, settings: chat.settings };
  return createChat(ctx, input);
}
export async function deleteChat(
  ctx: CatalogContext,
  id: string,
  version?: string,
): Promise<void> {
  await ctx.withLock(id, () => {
    const chat = ctx.store.getChat(id);
    requireVersion(chat.version, version);
    chat.status = 'deleting';
    chat.version += 1;
    ctx.store.saveChat(chat);
    for (const item of ctx.pending(id))
      if (item.state === 'pending') ctx.store.removePending(item.id);
    ctx.store.saveSettingsOperation(id, null);
    ctx.changed(id);
    return Promise.resolve();
  });
  ctx.schedule(id);
}
export async function updateSettings(
  ctx: CatalogContext,
  id: string,
  settings: ChatSettings,
  policy: SettingsOperation['policy'],
  version?: string,
): Promise<SettingsOperation> {
  const target = ctx.store.getChat(id);
  await ctx.validateSettings(settings, mapping(target));
  const result = await ctx.withLock(id, () => {
    const chat = ctx.store.getChat(id);
    requireVersion(chat.version, version);
    if (chat.status === 'deleting' || chat.status === 'creating')
      throw new ConflictError(
        'CHAT_UNAVAILABLE',
        'Wait for this chat to become available.',
      );
    if (ctx.store.settingsOperation(id))
      throw new ConflictError(
        'SETTINGS_PENDING',
        'This chat already has a pending settings change.',
      );
    const operation: SettingsOperation = {
      id: randomUUID(),
      settings,
      policy,
      status: 'pending',
    };
    ctx.store.saveSettingsOperation(id, operation);
    chat.version += 1;
    ctx.store.saveChat(chat);
    ctx.changed(id);
    return Promise.resolve(operation);
  });
  ctx.schedule(id);
  return result;
}
