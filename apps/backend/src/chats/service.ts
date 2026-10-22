import type {
  ChatSettings,
  ChatSnapshot,
  ChatSummary,
  ConversationCommand,
  ConversationEvent,
  ConversationResult,
  CreateChatRequest,
  PendingMessage,
  Preferences,
  SettingsOperation,
} from '@messenger/contracts';
import type { Gateway, GatewayMapping } from '../gateway/types.js';
import type { Store } from '../storage/store.js';
import type { MessageMedia } from './queue.js';

import {
  create,
  recoverChat,
  updateSettings,
  validateSettings,
  pending,
  preferences,
  removeChat,
  rename,
  updatePreferences,
} from './service-catalog.js';
import { runCommand } from './service-commands.js';
import { handleGatewayEvent } from './service-events.js';
import { localSnapshot, snapshot } from './service-history.js';
import { reconcile, resolveSettings } from './service-reconcile.js';
import { close, drain, onEvent, publish, withLock } from './service-runtime.js';
import { ServiceState } from './service-state.js';
export { mapping, summary } from './service-record.js';
export interface ServiceOptions {
  /** Durable Object alarms can drive recovery instead of process timers. */
  backgroundReconciliation?: boolean;
}
export class ChatService extends ServiceState {
  constructor(
    store: Store,
    gateway: Gateway,
    media?: MessageMedia,
    options: ServiceOptions = {},
  ) {
    super(store, gateway, media);
    if (options.backgroundReconciliation !== false)
      this.recoveryTimer = setInterval(() => {
        if (
          !this.closed &&
          this.gateway.ready &&
          (!this.reconciled ||
            this.store.tombstones().length ||
            this.store
              .listChats()
              .some(
                (chat) =>
                  chat.status === 'recovery' ||
                  chat.status === 'deleting' ||
                  chat.status === 'creating' ||
                  this.store.settingsOperation(chat.id)?.status === 'unknown',
              ))
        )
          void reconcile(this).catch(() => {
            this.reconciled = false;
          });
      }, 1000);
    this.recoveryTimer?.unref?.();
    this.unsubscribe = gateway.onEvent((event) => {
      void handleGatewayEvent(this, event).catch(() => {
        if (this.closed) return;
        this.reconciled = false;
        try {
          publish(this, { type: 'connection.state', state: 'unavailable' });
        } catch {
          /* A malformed fallback frame cannot recurse into publication or escape this asynchronous handler. */
        }
      });
    });
  }
  close(): void {
    return close(this);
  }
  drain(): Promise<void> {
    return drain(this);
  }
  onEvent(listener: (event: ConversationEvent) => void): () => void {
    return onEvent(this, listener);
  }
  snapshot(
    id: string,
    options: { refresh?: boolean } = {},
  ): Promise<ChatSnapshot> {
    return snapshot(this, id, options.refresh !== false);
  }
  /** Cached reads never invoke Gateway and are available while the engine sleeps. */
  cachedSnapshot(id: string): ChatSnapshot {
    return localSnapshot(this, id);
  }
  pending(id: string): PendingMessage[] {
    return pending(this, id);
  }
  preferences(): Preferences {
    return preferences(this);
  }
  updatePreferences(
    input: Omit<Preferences, 'version'>,
    version?: string,
  ): Promise<Preferences> {
    return updatePreferences(this, input, version);
  }
  validateSettings(
    settings: ChatSettings,
    target?: GatewayMapping,
  ): Promise<void> {
    return validateSettings(this, settings, target);
  }
  create(input: CreateChatRequest): Promise<ChatSummary> {
    return create(this, input);
  }
  rename(id: string, name: string, version?: string): Promise<ChatSummary> {
    return rename(this, id, name, version);
  }
  recoverChat(id: string, version?: string): Promise<ChatSummary> {
    return recoverChat(this, id, version);
  }
  delete(id: string, version?: string): Promise<void> {
    return removeChat(this, id, version);
  }
  updateSettings(
    id: string,
    settings: ChatSettings,
    policy: SettingsOperation['policy'],
    version?: string,
  ): Promise<SettingsOperation> {
    return updateSettings(this, id, settings, policy, version);
  }
  reconcile(): Promise<void> {
    return reconcile(this);
  }
  resolveSettings(
    id: string,
    action: 'retry' | 'discard',
    version?: string,
  ): Promise<{
    effective: ChatSettings;
    pending: SettingsOperation | null;
    version: number;
  }> {
    return resolveSettings(this, id, action, version);
  }
  command(command: ConversationCommand): Promise<ConversationResult> {
    return runCommand(this, command);
  }
  withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    return withLock(this, id, work);
  }
}
