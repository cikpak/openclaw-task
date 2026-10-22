import { GatewayClient } from '@openclaw/gateway-client';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { GatewayUnavailableError } from '../errors.js';
import type { GatewayEvent } from './types.js';
import { projectToolEvent } from './tools.js';
import { chatEventSchema } from './protocol-schemas.js';
import { messageText } from './messages.js';
import {
  gatewayScopes,
  loadIdentity,
  publicKeyRaw,
  signPayload,
} from './identity.js';
import { DEFAULT_GATEWAY_PAYLOAD } from '../uploads/validation.js';
export class NodeGatewayTransport {
  ready = false;
  maxPayload = DEFAULT_GATEWAY_PAYLOAD;
  private client: GatewayClient | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;
  private pairingDeadline = 0;
  stopped = false;
  private readonly identities: ReturnType<typeof loadIdentity>;
  constructor(
    private readonly config: Config,
    private readonly events: (event: GatewayEvent) => void,
  ) {
    this.identities = loadIdentity(
      config.dataDir,
      config.gatewayPublicIdentityFile,
    );
  }
  start(): void {
    this.stopped = false;
    this.connectWhenPinned();
  }
  private connectWhenPinned(): void {
    if (this.stopped) return;
    let fingerprint = this.config.gatewayTlsFingerprint;
    if (
      !fingerprint &&
      this.config.gatewayTlsFingerprintFile &&
      existsSync(this.config.gatewayTlsFingerprintFile)
    )
      fingerprint = readFileSync(
        this.config.gatewayTlsFingerprintFile,
        'utf8',
      ).trim();
    if (!fingerprint) {
      this.bootstrapTimer = setTimeout(() => this.connectWhenPinned(), 1000);
      this.bootstrapTimer.unref();
      return;
    }
    if (
      !/^(?:[A-Fa-f0-9]{2}:?){32}$/.test(fingerprint.replace(/^sha256\$/i, ''))
    )
      throw new Error('Invalid Gateway certificate fingerprint.');
    const tokenPath = join(this.config.dataDir, 'device-token.json');
    this.client = new GatewayClient({
      url: this.config.gatewayUrl,
      tlsFingerprint: fingerprint,
      token: this.config.gatewayToken,
      deviceIdentity: this.identities,
      role: 'operator',
      scopes: gatewayScopes,
      clientName: 'gateway-client',
      mode: 'backend',
      clientDisplayName: 'Messenger backend',
      clientVersion: '2026.10.1',
      caps: ['tool-events'],
      hostDeps: {
        signDevicePayload: signPayload,
        publicKeyRawBase64UrlFromPem: publicKeyRaw,
        loadDeviceAuthToken: () =>
          existsSync(tokenPath)
            ? z
                .object({ token: z.string(), scopes: z.array(z.string()) })
                .parse(JSON.parse(readFileSync(tokenPath, 'utf8')))
            : null,
        storeDeviceAuthToken: ({ token, scopes }) =>
          writeFileSync(tokenPath, JSON.stringify({ token, scopes }), {
            mode: 0o600,
          }),
        clearDeviceAuthToken: () =>
          writeFileSync(tokenPath, JSON.stringify({ token: '', scopes: [] }), {
            mode: 0o600,
          }),
      },
      onHelloOk: (hello) => {
        this.maxPayload = hello.policy.maxPayload;
        this.pairingDeadline = 0;
        clearTimeout(this.pairingTimer);
        this.ready = true;
        this.events({ type: 'connection', ready: true });
      },
      onClose: () => {
        this.ready = false;
        this.events({ type: 'connection', ready: false });
      },
      onConnectError: () => {
        this.ready = false;
        this.events({ type: 'connection', ready: false });
      },
      onReconnectPaused: (info) => this.retryPendingPairing(info.detailCode),
      onEvent: (frame) => {
        if (frame.event === 'agent') {
          const tool = projectToolEvent(frame.payload);
          if (tool) this.events(tool);
          return;
        }
        if (frame.event !== 'chat') return;
        const parsed = chatEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        const e = parsed.data;
        this.events({
          type: 'chat',
          sessionKey: e.sessionKey,
          runId: e.runId,
          sequence: e.seq,
          state: e.state,
          text: e.deltaText ?? messageText(e.message),
          replace: e.replace ?? e.deltaText === undefined,
        });
      },
    });
    this.client.start();
  }
  private retryPendingPairing(detailCode: string | null): void {
    // The official client pauses for manual pairing; our exact-identity helper approves it.
    if (detailCode !== 'PAIRING_REQUIRED' || this.stopped) return;
    this.pairingDeadline ||= Date.now() + 180_000;
    if (Date.now() + 2000 > this.pairingDeadline) return;
    clearTimeout(this.pairingTimer);
    const previous = this.client;
    this.pairingTimer = setTimeout(() => {
      void (async () => {
        await previous?.stopAndWait();
        if (
          this.stopped ||
          this.client !== previous ||
          Date.now() > this.pairingDeadline
        )
          return;
        this.connectWhenPinned();
      })().catch(() => {
        this.ready = false;
        this.events({ type: 'connection', ready: false });
      });
    }, 2000);
    this.pairingTimer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.bootstrapTimer);
    clearTimeout(this.pairingTimer);
    this.ready = false;
    await this.client?.stopAndWait();
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.ready || !this.client) throw new GatewayUnavailableError();
    return this.client.request<unknown>(method, params);
  }
}
