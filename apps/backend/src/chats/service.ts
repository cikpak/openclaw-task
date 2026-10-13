import { randomUUID } from 'node:crypto';
import type {
  ChatSettings,
  Attachment,
  ActiveRun,
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
import { z } from 'zod';
import { parseOutboundEvent } from '../outbound.js';
import {
  appendPreview,
  boundedPending,
  boundedRun,
  SettledRunProjection,
} from './projection.js';
import { historyWithReceipts } from './history.js';
import {
  createChat,
  renameChat,
  recoverChat,
  deleteChat,
  updateSettings,
} from './catalog.js';
import type { CatalogContext } from './catalog.js';
import { TitleCoordinator } from './titles.js';
import {
  readPreferences,
  savePreferences,
  validateSettings,
} from './preferences.js';
import { saveTool, tools } from './tools.js';
import { executeCommand } from './commands.js';
import { completeDeletion, applySettings } from './lifecycle.js';
import type { LifecycleContext } from './lifecycle.js';
import type { ChatRecord, Store } from '../database.js';
import { ConflictError, ValidationError, toProblem } from '../errors.js';
import type {
  Gateway,
  GatewayEvent,
  GatewayHistory,
  GatewayMapping,
} from '../gateway/types.js';
import { chatSchema, snapshotSchema } from '../schemas.js';
import { hasWork, reconcileInputs, requireVersion } from './queue.js';
import type { MessageMedia } from './queue.js';

export function summary(chat: ChatRecord): ChatSummary {
  return chatSchema.parse(chat);
}
export function mapping(chat: ChatRecord): GatewayMapping {
  if (!chat.agentId || !chat.sessionKey)
    throw new ConflictError(
      'CHAT_INITIALIZING',
      'This chat is still initializing.',
    );
  return { agentId: chat.agentId, sessionKey: chat.sessionKey };
}
type EventPayload<T> = T extends ConversationEvent
  ? Omit<T, 'generation' | 'sequence'>
  : never;
type DispatchClaim =
  | { kind: 'delete'; chat: ChatRecord }
  | { kind: 'settings'; chat: ChatRecord; operation: SettingsOperation }
  | { kind: 'message'; item: PendingMessage }
  | null;

export class ChatService {
  readonly generation = randomUUID();
  private sequence = 0;
  private connectionEpoch = 0;
  private closed = false;
  private readonly listeners = new Set<(event: ConversationEvent) => void>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly driving = new Map<string, Promise<void>>();
  private readonly steering = new Set<Promise<void>>();
  private readonly driveRequested = new Set<string>();
  private readonly stateEpochs = new Map<string, number>();
  private readonly readEpochs = new Map<string, number>();
  private readonly streams = new Map<string, ActiveRun>();
  private readonly settled = new SettledRunProjection();
  private readonly runSequences = new Map<string, number>();
  private readonly terminalRuns = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly titles: TitleCoordinator;
  private readonly recoveryTimer: ReturnType<typeof setInterval>;
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly refreshRetries = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private reconciliation: Promise<void> | null = null;
  private tombstoneOffset = 0;
  reconciled = false;
  constructor(
    readonly store: Store,
    readonly gateway: Gateway,
    private readonly media?: MessageMedia,
  ) {
    this.titles = new TitleCoordinator(
      store,
      gateway,
      (id) => this.changed(id, false),
      <T>(id: string, work: () => Promise<T>) => this.withLock(id, work),
    );
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
        void this.reconcile().catch(() => {
          this.reconciled = false;
        });
    }, 1000);
    this.recoveryTimer.unref();
    this.unsubscribe = gateway.onEvent((event) => {
      void this.handleGatewayEvent(event).catch(() => {
        if (this.closed) return;
        this.reconciled = false;
        try {
          this.publish({ type: 'connection.state', state: 'unavailable' });
        } catch {
          /* A malformed fallback frame cannot recurse into publication or escape this asynchronous handler. */
        }
      });
    });
  }
  close(): void {
    this.closed = true;
    this.settled.clear();
    this.titles.close();
    clearInterval(this.recoveryTimer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    for (const timer of this.refreshRetries.values()) clearTimeout(timer);
    this.unsubscribe();
  }
  async drain(): Promise<void> {
    await Promise.all([...this.driving.values(), ...this.steering]);
    await this.titles.drain();
  }
  private prepareMessage(
    settings: ChatSettings,
    ids: string[] = [],
    chatId?: string,
  ): Promise<Attachment[]> {
    if (!ids.length) return Promise.resolve([]);
    if (!this.media)
      throw new ValidationError('Attachments are not available yet.');
    return this.media.prepare(
      settings,
      ids,
      chatId ? mapping(this.store.getChat(chatId)) : undefined,
    );
  }
  private retry(id: string): void {
    if (this.retryTimers.has(id) || this.closed) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      if (this.store.listChats().some((chat) => chat.id === id))
        this.schedule(id);
    }, 1000);
    timer.unref();
    this.retryTimers.set(id, timer);
  }
  private retryRefresh(id: string): void {
    if (this.closed || this.refreshRetries.has(id)) return;
    const timer = setTimeout(() => {
      this.refreshRetries.delete(id);
      if (
        this.closed ||
        !this.gateway.ready ||
        !this.store.listChats().some((chat) => chat.id === id)
      )
        return;
      void this.refresh(id)
        .then(() => this.schedule(id))
        .catch(() => {
          this.reconciled = false;
        });
    }, 1000);
    timer.unref();
    this.refreshRetries.set(id, timer);
  }
  onEvent(listener: (event: ConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(event: EventPayload<ConversationEvent>): void {
    if (this.closed) return;
    const frame = parseOutboundEvent({
      ...event,
      generation: this.generation,
      sequence: this.sequence + 1,
    });
    this.sequence = frame.sequence;
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch {
        /* A failed subscriber cannot reject retained work or prevent other subscribers from receiving validated state. */
      }
    }
  }
  private changed(chatId: string, affectsExecution = true): void {
    if (affectsExecution)
      this.stateEpochs.set(chatId, (this.stateEpochs.get(chatId) ?? 0) + 1);
    const chat = this.store.getChat(chatId);
    chat.updatedAt = Date.now();
    this.store.saveChat(chat);
    this.publish({ type: 'conversation.updated', chat: summary(chat) });
    this.publish({
      type: 'conversation.snapshot',
      snapshot: this.localSnapshot(chatId),
    });
  }
  private beginRead(id: string): { state: number; read: number } {
    const read = (this.readEpochs.get(id) ?? 0) + 1;
    this.readEpochs.set(id, read);
    return { state: this.stateEpochs.get(id) ?? 0, read };
  }
  private currentRead(
    id: string,
    epoch: { state: number; read: number },
  ): boolean {
    return (
      epoch.state === (this.stateEpochs.get(id) ?? 0) &&
      epoch.read === this.readEpochs.get(id)
    );
  }
  private projectHistory(id: string, history: GatewayHistory): GatewayHistory {
    // Native terminal publication can precede controller cleanup in chat.history.
    // Exact terminal evidence outranks that transient snapshot, never a different run.
    return history.activeRun &&
      this.terminalRuns.has(`${id}:${history.activeRun.id}`)
      ? { ...history, activeRun: null }
      : history;
  }
  private localSnapshot(id: string): ChatSnapshot {
    if (this.streams.has(id) || this.store.getChat(id).status === 'deleting')
      this.settled.discard(id);
    const row = this.store.db
      .prepare('SELECT json FROM chat_history WHERE chat_id = ?')
      .get(id);
    const cached = row ? z.object({ json: z.string() }).parse(row).json : null;
    const history = cached
      ? z
          .object({
            messages: snapshotSchema.shape.messages,
            hasOlderHistory: z.boolean(),
            historyCursor: z.string().nullable(),
          })
          .parse(JSON.parse(cached))
      : null;
    const queue = boundedPending(this.store, id);
    return {
      chat: summary(this.store.getChat(id)),
      messages: history?.messages ?? [],
      pending: queue.pending,
      hiddenPendingCount: queue.hiddenPendingCount,
      activeRun: boundedRun(this.streams.get(id) ?? null),
      ...(this.settled.get(id) ? { settledRun: this.settled.get(id) } : {}),
      pendingSettings: this.store.settingsOperation(id),
      tools: tools(this.store, id),
      hasOlderHistory: history?.hasOlderHistory ?? false,
      historyCursor: history?.historyCursor ?? null,
    };
  }
  private cacheHistory(id: string, data: GatewayHistory): void {
    data = this.projectHistory(id, data);
    this.settled.reconcile(id, data.messages, data.activeRun);
    for (const tool of data.tools ?? []) saveTool(this.store, id, tool, -1);
    const snapshot = {
      ...this.localSnapshot(id),
      messages: data.messages,
      activeRun: boundedRun(data.activeRun),
      hasOlderHistory: data.hasOlderHistory,
      historyCursor: data.historyCursor,
    };
    this.store.db
      .prepare(
        'INSERT INTO chat_history VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      )
      .run(id, JSON.stringify(snapshotSchema.parse(snapshot)));
  }
  async snapshot(id: string): Promise<ChatSnapshot> {
    const chat = this.store.getChat(id);
    if (
      this.gateway.ready &&
      chat.agentId &&
      chat.sessionKey &&
      chat.status !== 'deleting'
    ) {
      const epoch = this.connectionEpoch;
      const observation = this.beginRead(id);
      try {
        const history = await this.gateway.history(mapping(chat));
        if (
          !this.closed &&
          epoch === this.connectionEpoch &&
          this.currentRead(id, observation)
        )
          this.cacheHistory(id, history);
      } catch {
        /* Cached state and accepted queues remain available offline. */
      }
    }
    return snapshotSchema.parse(this.localSnapshot(id));
  }
  pending(id: string): PendingMessage[] {
    return this.store.pending(id);
  }
  preferences(): Preferences {
    return readPreferences(this.store);
  }
  async updatePreferences(
    input: Omit<Preferences, 'version'>,
    version?: string,
  ): Promise<Preferences> {
    await this.validateSettings(input.defaults);
    return this.withLock('preferences', () =>
      Promise.resolve(savePreferences(this.store, input, version)),
    );
  }
  validateSettings(
    settings: ChatSettings,
    target?: GatewayMapping,
  ): Promise<void> {
    return validateSettings(this.gateway, settings, target);
  }
  private catalog(): CatalogContext {
    return {
      store: this.store,
      gateway: this.gateway,
      withLock: <T>(id: string, work: () => Promise<T>) =>
        this.withLock(id, work),
      validateSettings: (settings, target) =>
        this.validateSettings(settings, target),
      prepareMessage: (settings, ids, id) =>
        this.prepareMessage(settings, ids, id),
      refresh: (id) => this.refresh(id),
      schedule: (id) => this.schedule(id),
      changed: (id, affectsExecution) => this.changed(id, affectsExecution),
      pending: (id) => this.pending(id),
    };
  }
  create(input: CreateChatRequest): Promise<ChatSummary> {
    return createChat(this.catalog(), input);
  }
  rename(id: string, name: string, version?: string): Promise<ChatSummary> {
    return renameChat(this.catalog(), id, name, version);
  }
  recoverChat(id: string, version?: string): Promise<ChatSummary> {
    return recoverChat(this.catalog(), id, version);
  }
  delete(id: string, version?: string): Promise<void> {
    return deleteChat(this.catalog(), id, version);
  }
  updateSettings(
    id: string,
    settings: ChatSettings,
    policy: SettingsOperation['policy'],
    version?: string,
  ): Promise<SettingsOperation> {
    return updateSettings(this.catalog(), id, settings, policy, version);
  }
  reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    const work = this.reconcileAll().finally(() => {
      this.reconciliation = null;
    });
    this.reconciliation = work;
    return work;
  }
  private async reconcileAll(): Promise<void> {
    const epoch = this.connectionEpoch;
    let successful = true;
    this.reconciled = false;
    for (const chat of this.store.listChats()) {
      if (epoch !== this.connectionEpoch || !this.gateway.ready || this.closed)
        return;
      if (chat.status === 'deleting') {
        this.schedule(chat.id);
        continue;
      }
      if (!chat.agentId || !chat.sessionKey) {
        if (!this.gateway.recoverCreation) continue;
        let found: GatewayMapping | null;
        try {
          found = await this.gateway.recoverCreation(chat.id, chat.settings);
        } catch {
          successful = false;
          continue;
        }
        if (epoch !== this.connectionEpoch || this.closed) return;
        if (!found) continue;
        const current = this.store.getChat(chat.id);
        current.agentId = found.agentId;
        current.sessionKey = found.sessionKey;
        this.store.saveChat(current);
      }
      try {
        await this.refresh(chat.id);
      } catch {
        successful = false;
      }
      this.schedule(chat.id);
    }
    if (this.gateway.lookupCreation) {
      const tombstones = this.store.tombstones();
      for (const chat of tombstones.slice(
        this.tombstoneOffset,
        this.tombstoneOffset + 10,
      )) {
        let found: GatewayMapping | null;
        try {
          found = await this.gateway.lookupCreation(chat.id);
        } catch {
          successful = false;
          continue;
        }
        if (epoch !== this.connectionEpoch || this.closed) return;
        if (found) {
          try {
            await this.gateway.abort(found);
          } catch {
            /* An uncertain creation may have no session to abort. */
          }
          try {
            await this.gateway.remove(found);
          } catch {
            successful = false;
          }
        }
      }
      this.tombstoneOffset =
        this.tombstoneOffset + 10 >= tombstones.length
          ? 0
          : this.tombstoneOffset + 10;
    }
    if (epoch !== this.connectionEpoch || this.closed) return;
    this.reconciled =
      successful && epoch === this.connectionEpoch && this.gateway.ready;
    this.publish({
      type: 'connection.state',
      state: this.reconciled ? 'ready' : 'unavailable',
    });
  }
  async resolveSettings(
    id: string,
    action: 'retry' | 'discard',
    version?: string,
  ): Promise<{
    effective: ChatSettings;
    pending: SettingsOperation | null;
    version: number;
  }> {
    requireVersion(this.store.getChat(id).version, version);
    await this.refresh(id);
    const result = await this.withLock(id, () => {
      const chat = this.store.getChat(id);
      requireVersion(chat.version, version);
      const operation = this.store.settingsOperation(id);
      if (operation) {
        if (operation.status !== 'unknown')
          throw new ConflictError(
            'SETTINGS_CHANGED',
            'This settings operation changed. Reload before continuing.',
          );
        if (action === 'discard') this.store.saveSettingsOperation(id, null);
        else {
          operation.status = 'pending';
          this.store.saveSettingsOperation(id, operation);
        }
        chat.version += 1;
        this.store.saveChat(chat);
        this.changed(id);
      }
      return Promise.resolve({
        effective: chat.settings,
        pending: this.store.settingsOperation(id),
        version: chat.version,
      });
    });
    this.schedule(id);
    return result;
  }
  private async refresh(id: string): Promise<void> {
    const chat = this.store.getChat(id);
    const epoch = this.connectionEpoch;
    const observation = this.beginRead(id);
    const history = await historyWithReceipts(
      this.gateway,
      mapping(chat),
      this.pending(id)
        .filter((item) => item.state !== 'pending')
        .map((item) => item.submissionId),
    );
    if (epoch !== this.connectionEpoch || this.closed || !this.gateway.ready)
      return;
    await this.withLock(id, () => {
      if (!this.currentRead(id, observation)) {
        this.retryRefresh(id);
        return Promise.resolve();
      }
      const current = this.store.getChat(id);
      if (current.status === 'deleting') return Promise.resolve();
      const observed = this.projectHistory(id, history);
      reconcileInputs(this.store, id, observed);
      if (observed.activeRun) {
        const preview = boundedRun(observed.activeRun);
        if (preview) this.streams.set(id, preview);
        const key = `${id}:${observed.activeRun.id}`;
        this.runSequences.set(
          key,
          Math.max(
            this.runSequences.get(key) ?? -1,
            observed.activeRun.sequence,
          ),
        );
      } else this.streams.delete(id);
      current.settings = history.settings;
      current.status = this.pending(id).some((item) => item.state === 'unknown')
        ? 'recovery'
        : observed.activeRun
          ? 'running'
          : 'idle';
      const operation = this.store.settingsOperation(id);
      if (
        operation &&
        (operation.status === 'unknown' || operation.status === 'applying')
      ) {
        if (
          JSON.stringify(operation.settings) ===
            JSON.stringify(history.settings) &&
          (operation.policy !== 'cancel-work' ||
            !hasWork(this.store, id, Boolean(observed.activeRun)))
        )
          this.store.saveSettingsOperation(id, null);
        else {
          operation.status = 'unknown';
          this.store.saveSettingsOperation(id, operation);
        }
      }
      this.store.saveChat(current);
      this.cacheHistory(id, observed);
      this.changed(id);
      return Promise.resolve();
    });
    const subscribe = (
      this.gateway as Gateway & {
        subscribe?: (target: GatewayMapping) => Promise<void>;
      }
    ).subscribe;
    if (subscribe) await subscribe.call(this.gateway, mapping(chat));
  }
  async command(command: ConversationCommand): Promise<ConversationResult> {
    return this.withLock(`command:${command.commandId}`, async () => {
      const request = JSON.stringify(command);
      const previous = this.store.commandRequest(command.commandId);
      if (previous && previous !== request)
        return this.failure(
          command.commandId,
          new ConflictError(
            'COMMAND_ID_REUSED',
            'This command identity was already used with different values.',
          ),
        );
      // Snapshots and history are repeatable observations, not durable mutation receipts.
      // message.read changes unread state and keeps the normal mutation identity protection.
      if (
        command.type === 'conversation.snapshot.request' ||
        command.type === 'conversation.history.request'
      ) {
        try {
          return {
            type: 'command.result',
            commandId: command.commandId,
            ok: true,
            data: await this.withLock(command.chatId ?? 'snapshots', () =>
              this.execute(command),
            ),
          };
        } catch (error) {
          return this.failure(command.commandId, error);
        }
      }
      const stored = this.store.getCommand(command.commandId);
      if (stored) return stored;
      if (previous) {
        const pending =
          'chatId' in command && command.chatId
            ? this.pending(command.chatId).find(
                (item) => item.id === command.commandId,
              )
            : undefined;
        if (pending)
          return {
            type: 'command.result',
            commandId: command.commandId,
            ok: true,
            data: { messageId: pending.id },
          };
        return this.failure(
          command.commandId,
          new ConflictError(
            'COMMAND_OUTCOME_UNKNOWN',
            'The earlier command outcome is uncertain. Refresh this chat before continuing.',
          ),
        );
      }
      this.store.saveCommandRequest(command.commandId, request);
      let result: ConversationResult;
      try {
        result = {
          type: 'command.result',
          commandId: command.commandId,
          ok: true,
          data: await this.withLock(
            'chatId' in command && command.chatId
              ? command.chatId
              : 'snapshots',
            () => this.execute(command),
          ),
        };
      } catch (error) {
        result = this.failure(command.commandId, error);
      }
      this.store.saveCommand(result);
      if (result.ok && 'chatId' in command && command.chatId)
        this.schedule(command.chatId);
      return result;
    });
  }
  private failure(commandId: string, error: unknown): ConversationResult {
    return {
      type: 'command.result',
      commandId,
      ok: false,
      error: toProblem(error, randomUUID()),
    };
  }
  private execute(
    command: ConversationCommand,
  ): Promise<Extract<ConversationResult, { ok: true }>['data']> {
    return executeCommand(
      {
        store: this.store,
        gateway: this.gateway,
        streams: this.streams,
        snapshot: (id) => this.snapshot(id),
        pending: (id) => this.pending(id),
        projectHistory: (id, history) => this.projectHistory(id, history),
        preferences: () => this.preferences(),
        changed: (id, affectsExecution) => this.changed(id, affectsExecution),
        autoTitle: (id, text) => this.autoTitle(id, text),
        startSteer: (id, item) => this.startSteer(id, item),
        prepareMessage: (settings, ids, chatId) =>
          this.prepareMessage(settings, ids, chatId),
      },
      command,
    );
  }
  private autoTitle(id: string, text: string): void {
    this.titles.name(id, text);
  }
  private startSteer(id: string, item: PendingMessage): void {
    const job = this.submit(id, item, 'steer')
      .catch(() => {
        this.reconciled = false;
      })
      .finally(() => {
        this.steering.delete(job);
      });
    this.steering.add(job);
  }
  private schedule(id: string): void {
    if (this.closed || !this.gateway.ready) return;
    if (this.driving.has(id)) {
      this.driveRequested.add(id);
      return;
    }
    const job = this.drive(id)
      .catch(() => {
        this.reconciled = false;
      })
      .finally(() => {
        this.driving.delete(id);
        if (
          this.driveRequested.delete(id) &&
          !this.closed &&
          this.store.listChats().some((chat) => chat.id === id)
        )
          this.schedule(id);
      });
    this.driving.set(id, job);
  }
  private async drive(id: string): Promise<void> {
    const claim = await this.withLock<DispatchClaim>(id, () => {
      if (this.closed || !this.gateway.ready) return Promise.resolve(null);
      const chat = this.store.getChat(id);
      if (chat.status === 'deleting')
        return Promise.resolve({ kind: 'delete' as const, chat });
      if (!chat.agentId || chat.status === 'creating')
        return Promise.resolve(null);
      const operation = this.store.settingsOperation(id);
      if (operation) {
        if (operation.status !== 'pending') return Promise.resolve(null);
        if (
          operation.policy === 'cancel-work' ||
          !hasWork(this.store, id, this.streams.has(id))
        ) {
          operation.status = 'applying';
          this.store.saveSettingsOperation(id, operation);
          this.changed(id);
          return Promise.resolve({
            kind: 'settings' as const,
            chat,
            operation,
          });
        }
      }
      if (chat.status === 'recovery') return Promise.resolve(null);
      if (
        this.streams.has(id) ||
        this.pending(id).some((item) => item.state !== 'pending')
      )
        return Promise.resolve(null);
      const item = this.pending(id).find(
        (candidate) => candidate.state === 'pending',
      );
      if (!item) return Promise.resolve(null);
      item.state = 'submitting';
      this.store.savePending(item);
      this.autoTitle(id, item.text);
      this.changed(id);
      return Promise.resolve({ kind: 'message' as const, item });
    });
    if (!claim || this.closed) return;
    if (claim.kind === 'message') {
      await this.submit(id, claim.item, 'queue');
      return;
    }
    if (claim.kind === 'delete') {
      await completeDeletion(this.lifecycle(), claim.chat);
      return;
    }
    await applySettings(this.lifecycle(), claim.chat, claim.operation);
  }
  private async submit(
    id: string,
    item: PendingMessage,
    behavior: 'queue' | 'steer',
  ): Promise<void> {
    if (this.closed) return;
    const epoch = this.connectionEpoch;
    const revision = item.revision;
    const submissionId = item.submissionId;
    const owned = () =>
      this.pending(id).find(
        (candidate) =>
          candidate.id === item.id &&
          candidate.state === 'submitting' &&
          candidate.revision === revision &&
          candidate.submissionId === submissionId,
      );
    let invoked = false;
    try {
      const chat = this.store.getChat(id);
      if (!this.store.submissionScope(item.id)) {
        const history = await this.gateway.history(mapping(chat), {
          inputRunIds: [item.submissionId],
        });
        const retained = await this.withLock(id, () => {
          if (this.closed || !owned()) return Promise.resolve(false);
          if (
            history.sessionId &&
            epoch === this.connectionEpoch &&
            this.gateway.ready
          )
            this.store.saveSubmissionScope(item.id, history.sessionId);
          return Promise.resolve(true);
        });
        if (!retained) return;
      }
      const attachments = item.attachments.length
        ? await this.media?.payload(
            item.attachments,
            chat.settings,
            mapping(chat),
          )
        : undefined;
      const invocation = await this.withLock(id, () => {
        if (this.closed) return Promise.resolve(null);
        const pending = owned();
        if (!pending) return Promise.resolve(null);
        const current = this.store.getChat(id);
        if (current.status === 'deleting') return Promise.resolve(null);
        const operation = this.store.settingsOperation(id);
        if (
          !this.gateway.ready ||
          epoch !== this.connectionEpoch ||
          current.status === 'creating' ||
          current.status === 'recovery' ||
          current.agentId !== chat.agentId ||
          current.sessionKey !== chat.sessionKey ||
          JSON.stringify(current.settings) !== JSON.stringify(chat.settings) ||
          operation?.status === 'applying' ||
          operation?.status === 'unknown' ||
          operation?.policy === 'cancel-work' ||
          (behavior === 'queue' && this.streams.has(id)) ||
          (behavior === 'steer' && !this.streams.has(id))
        ) {
          // No Gateway invocation occurred: retain durable work for the next valid claim.
          pending.state = 'pending';
          this.store.savePending(pending);
          this.changed(id);
          this.retry(id);
          return Promise.resolve(null);
        }
        // Invoke under the chat lock, but wrap the ACK promise so the lock never waits on network.
        invoked = true;
        return Promise.resolve({
          ack: this.gateway.send(
            mapping(current),
            submissionId,
            pending.text,
            behavior,
            attachments,
          ),
        });
      });
      if (!invocation) return;
      const accepted = await invocation.ack;
      if (this.closed) return;
      await this.withLock(id, () => {
        const pending = owned();
        if (!pending) return Promise.resolve();
        const current = this.store.getChat(id);
        if (
          current.status === 'deleting' ||
          this.terminalRuns.has(`${id}:${accepted.runId}`)
        )
          return Promise.resolve();
        pending.submissionId = accepted.runId;
        pending.state = 'submitted';
        this.store.savePending(pending);
        if (!this.streams.has(id))
          this.streams.set(id, { id: accepted.runId, text: '', sequence: 0 });
        current.status = 'running';
        this.store.saveChat(current);
        this.changed(id);
        return Promise.resolve();
      });
    } catch {
      if (this.closed) return;
      const retained = await this.withLock(id, () => {
        const pending = owned();
        if (!pending) return Promise.resolve(false);
        const current = this.store.getChat(id);
        if (current.status === 'deleting') return Promise.resolve(false);
        pending.state = invoked ? 'unknown' : 'pending';
        this.store.savePending(pending);
        current.status =
          invoked || this.pending(id).some((entry) => entry.state === 'unknown')
            ? 'recovery'
            : this.streams.has(id)
              ? 'running'
              : 'idle';
        this.store.saveChat(current);
        this.changed(id);
        return Promise.resolve(true);
      });
      if (!invoked && retained) this.retry(id);
    }
  }
  private lifecycle(): LifecycleContext {
    const isClosed = () => this.closed;
    return {
      store: this.store,
      gateway: this.gateway,
      get closed() {
        return isClosed();
      },
      streams: this.streams,
      projectHistory: (id, history) => this.projectHistory(id, history),
      changed: (id) => this.changed(id),
      publish: (event) => this.publish(event),
      withLock: <T>(id: string, work: () => Promise<T>) =>
        this.withLock(id, work),
    };
  }
  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(id, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }
  private async handleGatewayEvent(event: GatewayEvent): Promise<void> {
    if (this.closed) return;
    if (event.type === 'connection') {
      const epoch = ++this.connectionEpoch;
      this.streams.clear();
      this.settled.clear();
      if (event.ready) await this.reconcile();
      else this.reconciled = false;
      if (epoch !== this.connectionEpoch) return;
      this.publish({
        type: 'connection.state',
        state: event.ready && this.reconciled ? 'ready' : 'unavailable',
      });
      return;
    }
    const chat = this.store
      .listChats()
      .find((candidate) => candidate.sessionKey === event.sessionKey);
    if (!chat || chat.status === 'deleting') return;
    if (event.type === 'tool') {
      const projected = saveTool(
        this.store,
        chat.id,
        event.tool,
        event.sequence,
      );
      if (projected) {
        this.stateEpochs.set(chat.id, (this.stateEpochs.get(chat.id) ?? 0) + 1);
        this.publish({
          type: 'conversation.tool',
          chatId: chat.id,
          tool: projected,
        });
        this.publish({
          type: 'conversation.snapshot',
          snapshot: this.localSnapshot(chat.id),
        });
      }
      return;
    }
    const key = `${chat.id}:${event.runId}`;
    if (
      this.terminalRuns.has(key) ||
      (this.runSequences.get(key) ?? -1) >= event.sequence
    )
      return;
    this.runSequences.set(key, event.sequence);
    if (event.state === 'delta') {
      const old = this.streams.get(chat.id);
      if (old && old.id !== event.runId) return;
      if (old && old.sequence >= event.sequence) return;
      this.settled.discard(chat.id);
      this.stateEpochs.set(chat.id, (this.stateEpochs.get(chat.id) ?? 0) + 1);
      const preview = appendPreview(
        old,
        event.runId,
        event.text,
        event.replace,
        event.sequence,
      );
      this.streams.set(chat.id, preview);
      if (old?.truncated && preview.truncated && old.text === preview.text)
        return;
      const replace = event.replace || preview.truncated === true;
      this.publish({
        type: 'conversation.run.text',
        chatId: chat.id,
        runId: event.runId,
        text: replace ? preview.text : event.text,
        replace,
        truncated: preview.truncated === true,
        runSequence: event.sequence,
      });
      return;
    }
    if (event.state === 'status') return;
    if (
      this.streams.get(chat.id)?.id !== event.runId &&
      !this.pending(chat.id).some((item) => item.submissionId === event.runId)
    )
      return;
    this.terminalRuns.add(key);
    if (this.terminalRuns.size > 500) {
      const oldest = this.terminalRuns.values().next().value;
      if (oldest) {
        this.terminalRuns.delete(oldest);
        this.runSequences.delete(oldest);
      }
    }
    const terminalState = event.state;
    await this.withLock(chat.id, () => {
      const current = this.store.getChat(chat.id);
      if (current.status === 'deleting') return Promise.resolve();
      this.settled.capture(
        chat.id,
        this.streams.get(chat.id)?.id === event.runId
          ? this.streams.get(chat.id)
          : undefined,
        terminalState,
        this.localSnapshot(chat.id).messages,
      );
      if (this.streams.get(chat.id)?.id === event.runId)
        this.streams.delete(chat.id);
      for (const item of this.pending(chat.id))
        if (item.submissionId === event.runId)
          this.store.removePending(item.id);
      current.status = this.streams.has(chat.id) ? 'running' : 'idle';
      current.unread = true;
      this.store.saveChat(current);
      this.changed(chat.id);
      return Promise.resolve();
    });
    try {
      await this.refresh(chat.id);
    } finally {
      this.schedule(chat.id);
    }
  }
}
