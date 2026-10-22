import type { ChatSummary, CreateChatRequest } from '@messenger/contracts';
import { ConflictError, GatewayUnavailableError } from '../errors.js';
import { createChatSchema } from '../schemas.js';
import type { ChatRecord } from '../storage/store.js';
import type { CatalogContext } from './catalog.js';
import { enqueue, requireContent } from './queue.js';
import { summary } from './service-record.js';
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
            commandId: crypto.randomUUID(),
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
