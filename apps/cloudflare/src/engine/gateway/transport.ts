import {
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  PROTOCOL_VERSION,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceIdentity,
} from '@openclaw/gateway-client/browser';
import type { GatewayTransport } from '../../../../backend/src/gateway/context.js';
import type { GatewayEvent } from '../../../../backend/src/gateway/types.js';
import { GatewayUnavailableError } from '../../../../backend/src/errors.js';
import { chatEventSchema } from '../../../../backend/src/gateway/protocol-schemas.js';
import { messageText } from '../../../../backend/src/gateway/messages.js';
import {
  managerIdentity,
  scopes,
  type AuthStorage,
  type ExpectedIdentity,
} from './identity.js';
import { socketFactory } from './socket.js';
export interface NativeTransportOptions {
  fetcher(): Fetcher;
  storage: AuthStorage;
  gatewayToken: string;
  pair(identity: ExpectedIdentity): Promise<void>;
}
const clientInfo = {
  id: 'gateway-client' as const,
  mode: 'cli' as const,
  version: '2026.10.1',
  platform: 'cloudflare-workers',
  displayName: 'Messenger manager',
};
export class NativeGatewayTransport implements GatewayTransport {
  ready = false;
  maxPayload = 8 * 1024 * 1024;
  stopped = true;
  private sdk: GatewayProtocolClient<GatewayBrowserDeviceAuthPlan> | undefined;
  private identityPromise: Promise<GatewayBrowserDeviceIdentity> | undefined;
  private generation = 0;
  private deviceToken = '';
  secrets(): string[] {
    return [this.options.gatewayToken, this.deviceToken].filter(Boolean);
  }
  private pairing: Promise<void> | undefined;
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly options: NativeTransportOptions,
    private readonly events: (event: GatewayEvent) => void,
  ) {}
  private loadIdentity() {
    return (this.identityPromise ??= managerIdentity(this.options.storage));
  }
  async identity(): Promise<ExpectedIdentity> {
    const identity = await this.loadIdentity();
    return {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      role: 'operator',
      scopes: [...scopes],
    };
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    void this.connect(generation).catch(() => {
      if (generation === this.generation) this.connection(false);
    });
  }
  private connection(ready: boolean) {
    this.ready = ready;
    this.events({ type: 'connection', ready });
    for (const notify of this.waiters) notify();
  }
  private async connect(generation: number) {
    const current = () => generation === this.generation && !this.stopped;
    const identity = await this.loadIdentity();
    if (!current()) return;
    const auth = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: () => Promise.resolve(identity),
      tokenStore: {
        load: async () => {
          if (!current()) return null;
          const value =
            (await this.options.storage.get<{
              token: string;
              scopes: string[];
            }>('deviceToken')) ?? null;
          this.deviceToken = value?.token ?? '';
          return value;
        },
        store: async (value) => {
          if (!current()) return;
          this.deviceToken = value.token;
          await this.options.storage.put('deviceToken', {
            token: value.token,
            scopes: value.scopes,
          });
        },
        clear: async () => {
          if (!current()) return;
          await this.options.storage.delete('deviceToken');
        },
      },
    });
    const sdk = new GatewayProtocolClient<GatewayBrowserDeviceAuthPlan>({
      createSocket: (handlers) =>
        socketFactory(this.options.fetcher(), handlers),
      createRequestId: () => crypto.randomUUID(),
      buildConnectPlan: async (context) => {
        const stored = await this.options.storage.get<{ token: string }>(
          'deviceToken',
        );
        return auth.buildPlan({
          client: clientInfo,
          role: 'operator',
          defaultScopes: scopes,
          ...(stored?.token ? {} : { token: this.options.gatewayToken }),
          nonce: context.nonce,
          ...(context.challengeTs === undefined
            ? {}
            : { challengeTs: context.challengeTs }),
        });
      },
      buildConnectParams: (plan) => ({
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        caps: ['tool-events'],
        role: plan.role,
        scopes: plan.scopes,
        auth: plan.auth,
        device: plan.device,
      }),
      onConnectHello: async (hello, context) => {
        if (!current()) return;
        context.assertCurrent();
        await auth.acceptHello(hello, context.plan);
      },
      onHello: (hello) => {
        if (!current()) return;
        this.maxPayload = hello.policy.maxPayload;
        this.connection(true);
      },
      onEvent: (frame) => {
        if (!current() || frame.event !== 'chat') return;
        const parsed = chatEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        const e = parsed.data;
        this.events({
          type: 'chat',
          sessionKey: e.sessionKey,
          runId: e.runId,
          sequence: e.seq,
          state: e.state,
          text:
            e.state === 'error'
              ? 'The request failed. Try again.'
              : (e.deltaText ?? messageText(e.message)),
          replace: e.replace ?? e.deltaText === undefined,
        });
      },
      onConnectFailure: async (error) => {
        if (!current())
          return {
            closeCode: 1000,
            closeReason: 'Superseded Gateway connection',
          };
        this.connection(false);
        if (error.code === 'NOT_PAIRED' && !this.stopped) {
          this.pairing ??= this.identity()
            .then((value) => this.options.pair(value))
            .finally(() => {
              this.pairing = undefined;
            });
          await this.pairing;
        }
        return {
          closeCode: 1008,
          closeReason: 'Gateway authentication pending',
        };
      },
      onClose: () => {
        if (current()) this.connection(false);
      },
      onConnectError: () => {
        if (current()) this.connection(false);
      },
      resolveClose: () => ({
        retry: !this.stopped && generation === this.generation,
        notify: true,
        reconnectDelayMs: 1000,
      }),
      handshake: { mode: 'require-challenge', timeoutMs: 15000 },
      reconnect: { initialMs: 1000, multiplier: 1.5, maxMs: 10000 },
      requestTimeoutMs: 30000,
    });
    this.sdk = sdk;
    sdk.start();
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.sdk?.stop();
    this.sdk = undefined;
    this.connection(false);
    return Promise.resolve();
  }
  async waitReady(timeoutMs = 300000): Promise<void> {
    if (this.ready) return;
    if (this.stopped) throw new GatewayUnavailableError();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (!this.ready && !this.stopped) return;
        clearTimeout(timer);
        this.waiters.delete(finish);
        if (this.ready) resolve();
        else reject(new GatewayUnavailableError());
      };
      const timer = setTimeout(() => {
        this.waiters.delete(finish);
        reject(new GatewayUnavailableError());
      }, timeoutMs);
      this.waiters.add(finish);
      finish();
    });
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.ready || !this.sdk) throw new GatewayUnavailableError();
    if (method === 'chat.history')
      params = {
        ...(params as object),
        limit: 1000,
        maxBytes: 8 * 1024 * 1024 - 1024,
        maxChars: 500000,
      };
    return this.sdk.request(method, params);
  }
}
