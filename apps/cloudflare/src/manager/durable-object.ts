import { DurableObject } from 'cloudflare:workers';
import type { ConversationEvent } from '@messenger/contracts';
import { DurableObjectStore } from '../../../backend/src/storage/durable-object.js';
import { ManagerAlarms } from './alarms.js';
import { ManagerFiles } from '../files/service.js';
import { BrowserBoundary } from '../files/boundary.js';
import { sendFrame } from './framing.js';
import { RecoveryGarbage } from '../files/garbage.js';
import { persistedNativeSecrets } from '../files/secrets.js';
import { readPreferences } from '../../../backend/src/chats/preferences.js';
import { ManagerAuthorization } from './authorization.js';
import { ManagerApplication } from './application.js';
import { ManagerEvents } from './events.js';
import { cachedSnapshot } from './cached.js';
import { createManagerEngine } from './engine.js';
import type { ManagerEngine, ManagerEnv } from './types.js';
import { SocketAuthorization } from './socket-auth.js';
import { ManagerHttp } from './http.js';

const FRAME_BYTES = 128 * 1024;
export class ConversationManager extends DurableObject<ManagerEnv> {
  private readonly http: ManagerHttp;
  private readonly store: DurableObjectStore;
  private readonly files: ManagerFiles;
  private readonly boundary: BrowserBoundary;
  private readonly garbage: RecoveryGarbage;
  private persistedSecrets: string[] = [];
  private readonly authorization: ManagerAuthorization;
  private readonly alarms: ManagerAlarms;
  private readonly engine: ManagerEngine | undefined;
  private readonly application: ManagerApplication;
  private readonly sockets: SocketAuthorization;
  private readonly events: ManagerEvents;
  constructor(state: DurableObjectState, env: ManagerEnv) {
    super(state, env);
    this.store = new DurableObjectStore(state.storage);
    this.authorization = new ManagerAuthorization(env, this.store);
    if (
      env.DEFAULT_MODEL &&
      !this.store.db.prepare('SELECT id FROM preferences WHERE id = 1').get()
    ) {
      const preferences = readPreferences(this.store);
      preferences.defaults.model = env.DEFAULT_MODEL;
      this.store.db
        .prepare('INSERT INTO preferences VALUES (1, ?)')
        .run(JSON.stringify(preferences));
    }
    this.alarms = new ManagerAlarms(state.storage);
    const context = {
      state,
      env,
      store: this.store,
      publish: (event: ConversationEvent) => this.events.publish(event),
      schedule: this.alarms,
    };
    this.files = new ManagerFiles(context, this.authorization);
    this.garbage = new RecoveryGarbage(context, this.files);
    this.boundary = new BrowserBoundary(() => {
      const credentials = this.store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'engine_credentials'",
        )
        .get()
        ? (this.store.db
            .prepare(
              'SELECT helper,gateway FROM engine_credentials WHERE id = 1',
            )
            .get() as { helper: string; gateway: string } | undefined)
        : undefined;
      return {
        ...this.files.catalog.policy(),
        secrets: [
          ...this.persistedSecrets,
          env.R2_ACCESS_KEY_ID ?? '',
          env.R2_SECRET_ACCESS_KEY ?? '',
          env.OPENAI_API_KEY ?? '',
          env.ANTHROPIC_API_KEY ?? '',
          credentials?.helper ?? '',
          credentials?.gateway ?? '',
        ],
      };
    });
    this.sockets = new SocketAuthorization(
      state,
      this.authorization,
      this.alarms,
    );
    this.events = new ManagerEvents(
      state,
      this.store,
      this.authorization,
      this.sockets,
      this.boundary,
    );
    this.http = new ManagerHttp(
      state,
      env,
      this.authorization,
      this.sockets,
      this.events,
      this.files,
    );
    this.engine = createManagerEngine(context, this.files, this.boundary);
    this.application = new ManagerApplication(
      this.store,
      this.authorization,
      this.engine,
      (work) =>
        state.waitUntil(
          work
            .catch(() => {})
            .finally(() =>
              this.alarms.set('engine', this.engine?.deadline() ?? null),
            ),
        ),
      this.files,
      this.boundary,
    );
    void state.blockConcurrencyWhile(async () => {
      await this.syncSecrets();
      await this.sockets.sync();
      await this.alarms.set('files', this.files.uploads.deadline());
      await this.alarms.set('engine', this.engine?.deadline() ?? null);
    });
  }
  override fetch(request: Request): Promise<Response> {
    return this.http.fetch(request);
  }
  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const admission = this.sockets.admission(socket);
    if (
      !admission ||
      admission.grant.expiresAt <= Date.now() ||
      this.authorization.revoked(admission.grant.sessionId)
    ) {
      this.sockets.close(socket);
      return;
    }
    if (
      typeof message !== 'string' ||
      new TextEncoder().encode(message).byteLength > FRAME_BYTES
    ) {
      socket.close(1009, 'Frame is too large.');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      socket.close(1007, 'Invalid message.');
      return;
    }
    await this.syncSecrets();
    const result = await this.application
      .transport(admission.grant)
      .dispatch(value, crypto.randomUUID());
    if (
      this.authorization.revoked(admission.grant.sessionId) ||
      admission.grant.expiresAt <= Date.now()
    ) {
      this.sockets.close(socket);
      return;
    }
    try {
      sendFrame(socket, this.boundary.project(result));
    } catch {
      /* Closed socket does not undo accepted work. */
    }
    if (result.ok && (result.data.messageId || result.data.chat)) {
      const chatId =
        result.data.chat?.id ??
        (value &&
        typeof value === 'object' &&
        'chatId' in value &&
        typeof value.chatId === 'string'
          ? value.chatId
          : undefined);
      if (
        chatId &&
        value &&
        typeof value === 'object' &&
        'type' in value &&
        value.type === 'conversation.message.read'
      ) {
        this.events.publish({
          type: 'conversation.updated',
          chat: this.store.getChat(chatId),
          generation: 'manager',
          sequence: 0,
        });
      } else if (chatId)
        this.events.publish({
          type: 'conversation.snapshot',
          snapshot:
            this.engine?.service.cachedSnapshot(chatId) ??
            cachedSnapshot(this.store, chatId),
          generation: 'manager',
          sequence: 0,
        });
    }
    await this.alarms.set('engine', this.engine?.deadline() ?? null);
    if (!result.ok && result.error.code === 'AUTHENTICATION_REQUIRED')
      this.sockets.close(socket);
  }
  private async syncSecrets(): Promise<void> {
    this.persistedSecrets = await persistedNativeSecrets(this.ctx.storage);
  }
  override async alarm(): Promise<void> {
    await this.sockets.renew();
    try {
      await this.engine?.tick();
    } catch {
      /* Lifecycle retains its own durable retry state. */
    }
    await this.files.uploads.cleanup();
    this.files.readers.prune();
    await this.alarms.set(
      'file-readers',
      this.files.readers.keys().size || this.files.readers.live()
        ? Date.now() + 1000
        : null,
    );
    await this.garbage.collect();
    await this.alarms.set('files', this.files.uploads.deadline());
    await this.alarms.set('engine', this.engine?.deadline() ?? null);
  }
  override async webSocketClose(
    socket: WebSocket,
    code: number,
  ): Promise<void> {
    try {
      socket.close(code, 'Connection closed.');
    } catch {
      /* Already closed. */
    }
    await this.sockets.sync();
  }
  override async webSocketError(socket: WebSocket): Promise<void> {
    this.sockets.close(socket);
    await this.sockets.sync();
  }
}
