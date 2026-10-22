import type {
  Attachment,
  ChatSettings,
  ChatSummary,
  PendingMessage,
  SettingsOperation,
} from '@messenger/contracts';
import { ConflictError } from '../errors.js';
import type { Gateway, GatewayMapping } from '../gateway/types.js';
import { createChatSchema } from '../schemas.js';
import type { Store } from '../storage/store.js';
import { requireVersion } from './queue.js';
import { mapping, summary } from './service-record.js';
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
import { createChat } from './creation.js';
export { createChat } from './creation.js';
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
      id: crypto.randomUUID(),
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
