import { GatewayClient } from '@openclaw/gateway-client';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type {
  ChatSettings,
  Message,
  ModelCapability,
} from '@messenger/contracts';
import { agentBehaviorEqual } from '@messenger/contracts';
import type { Config } from '../config.js';
import { GatewayUnavailableError, ValidationError } from '../errors.js';
import type {
  Gateway,
  GatewayEvent,
  GatewayHistory,
  GatewayMapping,
  GatewayAttachment,
} from './types.js';
import {
  projectToolEvent,
  projectToolText,
  projectTranscriptTools,
} from './tools.js';
import { WorkspaceArtifacts } from './workspace-artifacts.js';
import { AgentInstructions } from './agent-instructions.js';
import {
  decodeArtifactId,
  projectArtifactDownload,
  projectArtifacts,
} from './artifacts.js';
import { ApplicationError, NotFoundError } from '../errors.js';
import { DEFAULT_GATEWAY_PAYLOAD } from '../uploads/validation.js';
import {
  gatewayScopes,
  loadIdentity,
  publicKeyRaw,
  signPayload,
} from './identity.js';

const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  available: z.boolean().optional(),
  manualSelectionAllowed: z.boolean().optional(),
  thinkingLevels: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .optional(),
  thinkingDefault: z.string().optional(),
  supportsFastMode: z.boolean().optional(),
  input: z.array(z.string()).optional(),
});
const modelResultSchema = z.object({ models: z.array(modelSchema) });
const agentsResultSchema = z.object({
  agents: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
const upstreamMessageSchema = z
  .object({
    id: z.string().optional(),
    messageId: z.string().optional(),
    __openclaw: z
      .object({
        id: z.string().optional(),
        runId: z.string().min(1).optional(),
        seq: z.number().int().nonnegative().optional(),
        recordTimestampMs: z.number().optional(),
      })
      .optional(),
    role: z.string().optional(),
    runId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).max(256).optional(),
    toolName: z.string().max(100).optional(),
    content: z
      .union([
        z.string(),
        z.array(
          z
            .object({ type: z.string(), text: z.string().optional() })
            .passthrough(),
        ),
      ])
      .optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();
const chatEventSchema = z.object({
  sessionKey: z.string(),
  runId: z.string(),
  seq: z.number().int(),
  state: z.enum(['delta', 'final', 'aborted', 'error', 'status']),
  deltaText: z.string().optional(),
  message: z.unknown().optional(),
  replace: z.boolean().optional(),
});
const settingsEntrySchema = z
  .object({
    sessionId: z.string().optional(),
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    thinkingLevel: z.string().optional(),
    fastMode: z.union([z.boolean(), z.string()]).optional(),
  })
  .passthrough();
const patchResultSchema = z.object({
  ok: z.literal(true),
  entry: settingsEntrySchema,
  resolved: z.object({
    model: z.string(),
    modelProvider: z.string(),
    thinkingLevel: z.string().optional(),
  }),
});
const receiptSchema = z.object({
  runId: z.string(),
  state: z.enum(['pending', 'consumed']),
  cancelled: z.boolean().optional(),
});
const historySchema = z
  .object({
    sessionId: z.string().optional(),
    messages: z.array(z.unknown()),
    sessionInfo: settingsEntrySchema.optional(),
    thinkingLevel: z.string().optional(),
    fastMode: z.union([z.boolean(), z.string()]).optional(),
    inFlightRun: z
      .object({
        runId: z.string(),
        text: z.string().optional(),
        seq: z.number().optional(),
        message: z.unknown().optional(),
        events: z.array(z.unknown()).max(1000).optional(),
      })
      .passthrough()
      .optional(),
    deltaCursor: z.string().optional(),
    hasMore: z.boolean().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
    inputReceipts: z.array(receiptSchema).optional(),
  })
  .passthrough();
export function messageText(value: unknown): string {
  const p = upstreamMessageSchema.safeParse(value);
  if (!p.success) return '';
  const content = p.data.content;
  const text =
    typeof content === 'string'
      ? content
      : (content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('') ?? '');
  return p.data.role === 'tool' || p.data.role === 'toolResult'
    ? projectToolText(text)
    : text;
}
function canonicalModel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
function projectMessage(value: unknown, index: number): Message | null {
  const p = upstreamMessageSchema.safeParse(value);
  if (!p.success) return null;
  const role = p.data.role;
  if (
    role !== 'user' &&
    role !== 'assistant' &&
    role !== 'tool' &&
    role !== 'toolResult'
  )
    return null;
  const runId = p.data.__openclaw?.runId ?? p.data.runId;
  const toolName = z
    .enum(['read', 'write', 'edit', 'web_fetch'])
    .safeParse(p.data.toolName);
  return {
    id:
      p.data.__openclaw?.id ??
      p.data.id ??
      p.data.messageId ??
      (p.data.__openclaw?.seq !== undefined
        ? `history-seq-${p.data.__openclaw.seq}`
        : `history-${index}`),
    role: role === 'toolResult' ? 'tool' : role,
    text: messageText(value),
    ...(role === 'assistant' && p.data.stopReason === 'error'
      ? { requestFailed: true }
      : {}),
    ...(runId ? { runId } : {}),
    ...((role === 'tool' || role === 'toolResult') && p.data.toolCallId
      ? { toolCallId: p.data.toolCallId }
      : {}),
    ...((role === 'tool' || role === 'toolResult') && toolName.success
      ? { toolName: toolName.data }
      : {}),
    ...(p.data.__openclaw?.seq !== undefined
      ? { historySequence: p.data.__openclaw.seq }
      : {}),
    createdAt:
      typeof p.data.timestamp === 'number'
        ? p.data.timestamp
        : p.data.timestamp
          ? Date.parse(p.data.timestamp) || 0
          : (p.data.__openclaw?.recordTimestampMs ?? 0),
  };
}
export class OpenClawGateway implements Gateway {
  private readonly instructions: AgentInstructions;
  private readonly workspace: WorkspaceArtifacts;
  ready = false;
  maxPayload = DEFAULT_GATEWAY_PAYLOAD;
  private client: GatewayClient | null = null;
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;
  private pairingDeadline = 0;
  private stopped = false;
  private readonly identities: ReturnType<typeof loadIdentity>;
  private readonly knownSettings = new Map<string, ChatSettings>();
  private readonly verifiedModels = new Map<string, ModelCapability[]>();
  private capabilityGeneration = 0;
  private agentConfigurationTail: Promise<void> = Promise.resolve();
  constructor(private readonly config: Config) {
    this.instructions = new AgentInstructions((method, params) =>
      this.request(method, params),
    );
    this.workspace = new WorkspaceArtifacts(config.gatewayWorkspaceDir);
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
        this.emit({ type: 'connection', ready: true });
      },
      onClose: () => {
        this.ready = false;
        this.emit({ type: 'connection', ready: false });
      },
      onConnectError: () => {
        this.ready = false;
        this.emit({ type: 'connection', ready: false });
      },
      onReconnectPaused: (info) => this.retryPendingPairing(info.detailCode),
      onEvent: (frame) => {
        if (frame.event === 'agent') {
          const tool = projectToolEvent(frame.payload);
          if (tool) this.emit(tool);
          return;
        }
        if (frame.event !== 'chat') return;
        const parsed = chatEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        const e = parsed.data;
        this.emit({
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
        this.emit({ type: 'connection', ready: false });
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
  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.ready || !this.client) throw new GatewayUnavailableError();
    return this.client.request<unknown>(method, params);
  }
  async models(mapping?: GatewayMapping): Promise<ModelCapability[]> {
    const generation = this.capabilityGeneration;
    const knownScope = mapping && this.knownSettings.has(mapping.sessionKey);
    const data = modelResultSchema.parse(
      await this.request('models.list', {
        includeDetails: true,
        view: 'configured',
        ...(mapping
          ? { agentId: mapping.agentId, sessionKey: mapping.sessionKey }
          : {}),
      }),
    );
    const models = data.models.map((m) => ({
      id: canonicalModel(m.provider, m.id),
      name: m.name,
      provider: m.provider,
      available: m.available !== false && m.manualSelectionAllowed !== false,
      thinkingLevels: m.thinkingLevels ?? [{ id: 'off', label: 'Off' }],
      thinkingDefault: m.thinkingDefault ?? m.thinkingLevels?.[0]?.id ?? 'off',
      supportsFastMode: m.supportsFastMode === true,
      fastModeSupport:
        m.supportsFastMode === undefined
          ? ('unknown' as const)
          : m.supportsFastMode
            ? ('supported' as const)
            : ('unsupported' as const),
      input: m.input ?? ['text'],
    }));
    if (
      mapping &&
      knownScope &&
      generation === this.capabilityGeneration &&
      this.knownSettings.has(mapping.sessionKey)
    ) {
      const key = JSON.stringify([mapping.agentId, mapping.sessionKey]);
      this.verifiedModels.delete(key);
      // The application has at most ten active agents. Catalogs are bounded too.
      this.verifiedModels.set(key, structuredClone(models.slice(0, 500)));
      if (this.verifiedModels.size > 10) {
        const oldest = this.verifiedModels.keys().next().value;
        if (oldest) this.verifiedModels.delete(oldest);
      }
    }
    return models;
  }
  cachedModels(mapping: GatewayMapping): ModelCapability[] | null {
    const models = this.verifiedModels.get(
      JSON.stringify([mapping.agentId, mapping.sessionKey]),
    );
    return models ? structuredClone(models) : null;
  }
  async create(id: string, settings: ChatSettings): Promise<GatewayMapping> {
    return this.withAgentConfiguration(async () => {
      const agent = z
        .object({ ok: z.literal(true), agentId: z.string() })
        .parse(
          await this.request('agents.create', {
            name: `messenger-${id}`,
            model: settings.model,
          }),
        );
      return this.initializeSession(id, agent.agentId, settings);
    });
  }
  async recoverCreation(
    id: string,
    settings: ChatSettings,
  ): Promise<GatewayMapping | null> {
    return this.withAgentConfiguration(async () => {
      const found = await this.lookupCreation(id);
      if (!found) return null;
      // This is only called for an unconfirmed creation. Ordinary reconnect only reads history.
      return this.initializeSession(id, found.agentId, settings);
    });
  }
  private async withAgentConfiguration<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    // Agent config is global; a later hot reload can replace another creation's database target.
    // This gate deliberately excludes ordinary chat sends, history and per-chat settings.
    const previous = this.agentConfigurationTail;
    let release!: () => void;
    this.agentConfigurationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async lookupCreation(id: string): Promise<GatewayMapping | null> {
    const expectedAgentId = `messenger-${id}`;
    const agents = agentsResultSchema.parse(
      await this.request('agents.list', {}),
    );
    const agent = agents.agents.find((entry) => entry.id === expectedAgentId);
    if (!agent) return null;
    return { agentId: agent.id, sessionKey: `agent:${agent.id}:main` };
  }
  async title(
    mapping: GatewayMapping,
    model: string,
    message: string,
  ): Promise<string | null> {
    return z
      .object({ title: z.string().trim().min(1).max(100).nullable() })
      .parse(
        await this.request('sessions.title.prepare', {
          agentId: mapping.agentId,
          model,
          message,
        }),
      ).title;
  }
  async exists(mapping: GatewayMapping): Promise<boolean> {
    const agents = agentsResultSchema.parse(
      await this.request('agents.list', {}),
    );
    return agents.agents.some((entry) => entry.id === mapping.agentId);
  }
  private async initializeSession(
    id: string,
    agentId: string,
    settings: ChatSettings,
  ): Promise<GatewayMapping> {
    // agents.create acknowledges the committed config before Gateway hot reload sees it.
    const deadline = Date.now() + 20_000;
    while (
      !(await this.exists({ agentId, sessionKey: `agent:${agentId}:main` }))
    ) {
      if (this.stopped || Date.now() >= deadline)
        throw new GatewayUnavailableError();
      await delay(250);
    }
    const createParams = {
      agentId,
      key: `agent:${agentId}:main`,
      idempotencyKey: id,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      fastMode: settings.fastMode,
      permissionMode: 'workspace',
    };
    let created: unknown;
    for (;;) {
      try {
        created = await this.request('sessions.create', createParams);
        break;
      } catch (error) {
        const transient =
          error instanceof Error &&
          'code' in error &&
          error.code === 'INVALID_REQUEST' &&
          error.message.startsWith(`Unknown agent id "${agentId}".`);
        if (!transient || this.stopped || Date.now() >= deadline) throw error;
        await delay(250);
      }
    }
    const session = z
      .object({ ok: z.literal(true), key: z.string() })
      .parse(created);
    const mapping = { agentId, sessionKey: session.key };
    await this.settings(mapping, settings);
    await this.models(mapping);
    await this.subscribe(mapping);
    return mapping;
  }
  async subscribe(mapping: GatewayMapping): Promise<void> {
    await this.request('sessions.messages.subscribe', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
    });
  }
  async remove(mapping: GatewayMapping): Promise<void> {
    return this.withAgentConfiguration(async () => {
      z.object({ ok: z.literal(true) }).parse(
        await this.request('agents.delete', {
          agentId: mapping.agentId,
          deleteFiles: true,
        }),
      );
      const deadline = Date.now() + 20_000;
      while (await this.exists(mapping)) {
        if (this.stopped || Date.now() >= deadline)
          throw new GatewayUnavailableError();
        await delay(250);
      }
      // Invalidate older reads without accumulating per-deleted-agent tombstones.
      this.capabilityGeneration += 1;
      this.verifiedModels.delete(
        JSON.stringify([mapping.agentId, mapping.sessionKey]),
      );
      this.knownSettings.delete(mapping.sessionKey);
    });
  }
  async settings(
    mapping: GatewayMapping,
    desired: ChatSettings,
  ): Promise<ChatSettings> {
    const generation = this.capabilityGeneration;
    // Read and validate before mutating either native resource. The operation stays
    // recoverable if session patch, conditional file write or readback is uncertain.
    await this.instructions.read(mapping);
    const data = patchResultSchema.parse(
      await this.request('sessions.patch', {
        key: mapping.sessionKey,
        agentId: mapping.agentId,
        model: desired.model,
        thinkingLevel: desired.thinkingLevel,
        fastMode: desired.fastMode,
      }),
    );
    const effective = {
      model: canonicalModel(data.resolved.modelProvider, data.resolved.model),
      thinkingLevel:
        data.resolved.thinkingLevel ??
        data.entry.thinkingLevel ??
        desired.thinkingLevel,
      fastMode: data.entry.fastMode === true,
      ...(await this.instructions.apply(mapping, desired)),
    };
    if (generation === this.capabilityGeneration)
      this.knownSettings.set(mapping.sessionKey, effective);
    const readBack = await this.history(mapping);
    if (!agentBehaviorEqual(effective, readBack.settings))
      throw new ApplicationError(
        409,
        'AGENT_INSTRUCTIONS_UNCONFIRMED',
        'Agent instructions changed during verification. Refresh before trying again.',
      );
    return readBack.settings;
  }
  async history(
    mapping: GatewayMapping,
    options: { cursor?: string; inputRunIds?: string[] } = {},
  ): Promise<GatewayHistory> {
    const generation = this.capabilityGeneration;
    // Gateway cursors catch up forwards; older pages use the authoritative nextOffset.
    const offset = options.cursor
      ? Number(/^older:(\d+)$/.exec(options.cursor)?.[1])
      : undefined;
    if (options.cursor && (!Number.isSafeInteger(offset) || (offset ?? 0) < 1))
      throw new ValidationError(
        'The history page is invalid. Refresh this chat.',
      );
    const data = historySchema.parse(
      await this.request('chat.history', {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
        limit: 50,
        maxBytes: 262144,
        ...(offset === undefined ? {} : { offset }),
        ...(options.inputRunIds?.length
          ? { inputRunIds: options.inputRunIds }
          : {}),
      }),
    );
    const entry = data.sessionInfo;
    const known = this.knownSettings.get(mapping.sessionKey);
    const model =
      entry?.model && entry.modelProvider
        ? canonicalModel(entry.modelProvider, entry.model)
        : known?.model;
    if (!model) throw new GatewayUnavailableError();
    const settings = {
      model,
      thinkingLevel:
        data.thinkingLevel ??
        entry?.thinkingLevel ??
        known?.thinkingLevel ??
        'off',
      fastMode: (data.fastMode ?? entry?.fastMode) === true,
      ...(await this.instructions.read(mapping)),
    };
    if (generation === this.capabilityGeneration)
      this.knownSettings.set(mapping.sessionKey, settings);
    const run = data.inFlightRun;
    return {
      ...((data.sessionId ?? entry?.sessionId)
        ? { sessionId: data.sessionId ?? entry?.sessionId }
        : {}),
      messages: data.messages
        .map(projectMessage)
        .filter((m): m is Message => m !== null),
      activeRun: run
        ? {
            id: run.runId,
            text: run.text ?? messageText(run.message),
            sequence: run.seq ?? 0,
          }
        : null,
      historyCursor:
        data.hasMore && data.nextOffset !== undefined
          ? `older:${data.nextOffset}`
          : null,
      hasOlderHistory: data.hasMore ?? data.messages.length >= 50,
      settings,
      tools: [
        ...projectTranscriptTools(data.messages),
        ...(run?.events ?? [])
          .map(projectToolEvent)
          .filter(
            (event): event is Extract<GatewayEvent, { type: 'tool' }> =>
              event !== null && event.sessionKey === mapping.sessionKey,
          )
          .map((event) => event.tool),
      ].slice(-100),
      receipts: data.inputReceipts ?? [],
    };
  }
  async send(
    mapping: GatewayMapping,
    submissionId: string,
    text: string,
    behavior: 'queue' | 'steer',
    attachments: GatewayAttachment[] = [],
  ): Promise<{ runId: string; status: string }> {
    const params = {
      sessionKey: mapping.sessionKey,
      agentId: mapping.agentId,
      message: text,
      idempotencyKey: submissionId,
      queueMode: behavior === 'steer' ? 'steer' : 'followup',
      ...(attachments.length ? { attachments } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(params)) + 1024 > this.maxPayload)
      throw new ApplicationError(
        413,
        'GATEWAY_PAYLOAD_LIMIT',
        'This message exceeds the current OpenClaw transfer limit.',
      );
    return z
      .object({ runId: z.string(), status: z.string() })
      .parse(await this.request('chat.send', params));
  }
  async artifacts(mapping: GatewayMapping) {
    const [general, images] = await Promise.all([
      this.request('artifacts.list', {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
      }),
      // Inline transcript images use the pinned Gateway's separate paginated index.
      this.request('artifacts.list', {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
        type: 'image',
        limit: 4,
      }),
    ]);
    const catalog = new Map(
      [
        ...projectArtifacts(general, mapping),
        ...projectArtifacts(images, mapping),
      ].map((item) => [item.id, item]),
    );
    const workspace = await this.workspace.list(mapping);
    return [...workspace, ...catalog.values()].slice(0, 100);
  }
  async artifact(mapping: GatewayMapping, id: string) {
    const artifactId = decodeArtifactId(id);
    if (this.workspace.handles(artifactId))
      return this.workspace.download(mapping, artifactId);
    try {
      return projectArtifactDownload(
        await this.request('artifacts.download', {
          sessionKey: mapping.sessionKey,
          agentId: mapping.agentId,
          artifactId,
        }),
        mapping,
        artifactId,
      );
    } catch (error) {
      const rejected = z
        .object({
          code: z.literal('INVALID_REQUEST'),
          details: z.object({ type: z.string() }),
        })
        .safeParse(error);
      if (
        rejected.success &&
        ['artifact_not_found', 'artifact_scope_not_found'].includes(
          rejected.data.details.type,
        )
      )
        throw new NotFoundError();
      if (
        rejected.success &&
        rejected.data.details.type === 'artifact_download_unsupported'
      )
        throw new ApplicationError(
          422,
          'ARTIFACT_DOWNLOAD_UNSUPPORTED',
          'OpenClaw cannot safely transfer this artifact.',
        );
      throw error;
    }
  }
  async resolveArtifact(mapping: GatewayMapping, path: string) {
    const sourcePath = this.workspace.sourcePath(mapping, path);
    const artifact = (await this.artifacts(mapping)).find(
      (item) => item.sourcePath === sourcePath,
    );
    if (!artifact) throw new NotFoundError();
    return artifact;
  }
  async abort(mapping: GatewayMapping): Promise<void> {
    await this.request('sessions.abort', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
      clearQueued: true,
    });
  }
}
