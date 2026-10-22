import { DurableObject } from 'cloudflare:workers';
import { DurableObjectStore } from '../../../backend/src/storage/durable-object.js';
import { ManagerAlarms } from './alarms.js';
import { ManagerAuthorization } from './authorization.js';
import { ManagerApplication } from './application.js';
import { ManagerEvents } from './events.js';
import { cachedSnapshot } from './cached.js';
import { createManagerEngine } from './engine.js';
import type {
  Grant,
  ManagerEngine,
  ManagerEnv,
  SocketAdmission,
} from './types.js';
import { SocketAuthorization, renewalTime } from './socket-auth.js';

const FRAME_BYTES = 128 * 1024;
export class ConversationManager extends DurableObject<ManagerEnv> {
  private readonly store: DurableObjectStore;
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
    this.alarms = new ManagerAlarms(state.storage);
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
    );
    this.engine = createManagerEngine({
      state,
      env,
      store: this.store,
      publish: (event) => this.events.publish(event),
      schedule: this.alarms,
    });
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
    );
    void state.blockConcurrencyWhile(async () => {
      await this.sockets.sync();
      await this.alarms.set('engine', this.engine?.deadline() ?? null);
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/internal/revoke' && request.method === 'POST') {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (
        !input ||
        typeof input !== 'object' ||
        !('sessionId' in input) ||
        typeof input.sessionId !== 'string'
      )
        return new Response(null, { status: 400 });
      this.authorization.revoke(input.sessionId);
      for (const socket of this.ctx.getWebSockets())
        if (this.sockets.admission(socket)?.grant.sessionId === input.sessionId)
          this.sockets.close(socket);
      await this.sockets.sync();
      return new Response(null, { status: 204 });
    }
    if (path !== '/ws/conversation') return new Response(null, { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426 });
    const origin = request.headers.get('Origin');
    if (origin !== this.env.APP_ORIGIN)
      return new Response(null, { status: 403 });
    let grant: Grant;
    try {
      grant = await this.sockets.consume(request);
    } catch {
      return new Response(null, { status: 401 });
    }
    // A notification arriving while backend consumption was pending wins admission.
    if (this.authorization.revoked(grant.sessionId))
      return new Response(null, { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server!.serializeAttachment({
      grant,
      renewAt: renewalTime(grant),
    } satisfies SocketAdmission);
    this.ctx.acceptWebSocket(server!);
    await this.sockets.sync();
    this.events.connection(server!);
    return new Response(null, { status: 101, webSocket: client! });
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
      socket.send(JSON.stringify(result));
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
      if (chatId)
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
  override async alarm(): Promise<void> {
    await this.sockets.renew();
    try {
      await this.engine?.tick();
    } catch {
      /* Lifecycle retains its own durable retry state. */
    }
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
