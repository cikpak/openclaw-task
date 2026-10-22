import type {
  Attachment,
  ChatSettings,
  ChatSummary,
  CreateChatRequest,
  PendingMessage,
  Preferences,
  SettingsOperation,
} from '@messenger/contracts';
import { ValidationError } from '../errors.js';
import type { GatewayMapping } from '../gateway/types.js';
import type { CatalogContext } from './catalog.js';
import {
  createChat,
  deleteChat,
  recoverChat as recoverCatalogChat,
  renameChat,
  updateSettings as updateCatalogSettings,
} from './catalog.js';
import type { LifecycleContext } from './lifecycle.js';
import {
  readPreferences,
  savePreferences,
  validateSettings as validateGatewaySettings,
} from './preferences.js';

import { schedule } from './service-dispatch.js';
import { projectHistory, refresh } from './service-history.js';
import { mapping } from './service-record.js';
import { changed, publish, withLock } from './service-runtime.js';
import type { ServiceState } from './service-state.js';
import {
  locallyUninvoked,
  invalidateChatSubmissions,
} from './submission-claims.js';
export function prepareMessage(
  ctx: ServiceState,
  settings: ChatSettings,
  ids: string[] = [],
  chatId?: string,
): Promise<Attachment[]> {
  if (!ids.length) return Promise.resolve([]);
  if (!ctx.media)
    throw new ValidationError('Attachments are not available yet.');
  return ctx.media.prepare(
    settings,
    ids,
    chatId ? mapping(ctx.store.getChat(chatId)) : undefined,
  );
}
export function pending(ctx: ServiceState, id: string): PendingMessage[] {
  return ctx.store.pending(id);
}
export function preferences(ctx: ServiceState): Preferences {
  return readPreferences(ctx.store);
}
export async function updatePreferences(
  ctx: ServiceState,
  input: Omit<Preferences, 'version'>,
  version?: string,
): Promise<Preferences> {
  await validateSettings(ctx, input.defaults);
  return withLock(ctx, 'preferences', () =>
    Promise.resolve(savePreferences(ctx.store, input, version)),
  );
}
export function validateSettings(
  ctx: ServiceState,
  settings: ChatSettings,
  target?: GatewayMapping,
): Promise<void> {
  return validateGatewaySettings(ctx.gateway, settings, target);
}
export function catalog(ctx: ServiceState): CatalogContext {
  return {
    store: ctx.store,
    gateway: ctx.gateway,
    withLock: <T>(id: string, work: () => Promise<T>) =>
      withLock(ctx, id, work),
    validateSettings: (settings, target) =>
      validateSettings(ctx, settings, target),
    prepareMessage: (settings, ids, id) =>
      prepareMessage(ctx, settings, ids, id),
    refresh: (id) => refresh(ctx, id),
    schedule: (id) => schedule(ctx, id),
    changed: (id, affectsExecution) => changed(ctx, id, affectsExecution),
    pending: (id) => pending(ctx, id),
  };
}
export function create(
  ctx: ServiceState,
  input: CreateChatRequest,
): Promise<ChatSummary> {
  return createChat(catalog(ctx), input);
}
export function rename(
  ctx: ServiceState,
  id: string,
  name: string,
  version?: string,
): Promise<ChatSummary> {
  return renameChat(catalog(ctx), id, name, version);
}
export function recoverChat(
  ctx: ServiceState,
  id: string,
  version?: string,
): Promise<ChatSummary> {
  return recoverCatalogChat(catalog(ctx), id, version);
}
export function removeChat(
  ctx: ServiceState,
  id: string,
  version?: string,
): Promise<void> {
  return deleteChat(catalog(ctx), id, version);
}
export function updateSettings(
  ctx: ServiceState,
  id: string,
  settings: ChatSettings,
  policy: SettingsOperation['policy'],
  version?: string,
): Promise<SettingsOperation> {
  return updateCatalogSettings(catalog(ctx), id, settings, policy, version);
}
export function lifecycle(ctx: ServiceState): LifecycleContext {
  const isClosed = () => ctx.closed;
  return {
    store: ctx.store,
    gateway: ctx.gateway,
    get closed() {
      return isClosed();
    },
    streams: ctx.streams,
    locallyUninvoked: (item) => locallyUninvoked(ctx, item),
    invalidateUninvoked: (id) => invalidateChatSubmissions(ctx, id),
    projectHistory: (id, history) => projectHistory(ctx, id, history),
    changed: (id) => changed(ctx, id),
    publish: (event) => publish(ctx, event),
    withLock: <T>(id: string, work: () => Promise<T>) =>
      withLock(ctx, id, work),
  };
}
export function autoTitle(ctx: ServiceState, id: string, text: string): void {
  ctx.titles.name(id, text);
}
