import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayClientOptions } from '@openclaw/gateway-client';
import type { Config } from '../src/config.js';
import type { GatewayEvent } from '../src/gateway/types.js';
import { z } from 'zod';
import { nativeAgentFileRequest } from './native-agent-files.js';
import { settingsSchema } from '../src/schemas.js';

const transport = vi.hoisted(
  (): {
    options: GatewayClientOptions | null;
    requests: { method: string; params: unknown }[];
    response: unknown;
    responses: Record<string, unknown>;
    connections: number;
    failures: Record<string, Error[]>;
    handler: ((method: string, params: unknown) => unknown) | null;
    files: Map<string, string>;
  } => ({
    options: null,
    requests: [],
    response: {},
    responses: {},
    connections: 0,
    failures: {},
    handler: null,
    files: new Map(),
  }),
);
vi.mock('@openclaw/gateway-client', () => ({
  GatewayClient: class {
    constructor(options: GatewayClientOptions) {
      transport.connections++;
      transport.options = options;
    }
    start(): void {}
    stopAndWait(): Promise<void> {
      return Promise.resolve();
    }
    request(method: string, params: unknown): Promise<unknown> {
      transport.requests.push({ method, params });
      const failure = transport.failures[method]?.shift();
      if (failure) return Promise.reject(failure);
      if (method === 'agents.files.get' || method === 'agents.files.set')
        return Promise.resolve(
          Object.hasOwn(transport.responses, method)
            ? transport.responses[method]
            : nativeAgentFileRequest(transport.files, method, params),
        );
      if (transport.handler)
        return Promise.resolve(transport.handler(method, params));
      return Promise.resolve(
        transport.responses[method] ??
          (method === 'models.list'
            ? {
                models: [
                  {
                    id: 'model',
                    name: 'Mock model',
                    provider: 'mock',
                    input: ['text', 'image'],
                  },
                ],
              }
            : transport.response),
      );
    }
  },
}));
import { OpenClawGateway } from '../src/gateway/openclaw.js';
import { WorkspaceArtifacts } from '../src/gateway/workspace-artifacts.js';

const config = (): Config => ({
  trustProxyHops: 0,
  host: 'localhost',
  port: 3000,
  dataDir: mkdtempSync(join(tmpdir(), 'messenger-gateway-')),
  origin: 'https://localhost',
  secureCookies: true,
  username: 'owner',
  passwordHash: '',
  sessionKey: Buffer.alloc(32),
  sessionLifetimeSeconds: 86400,
  gatewayUrl: 'wss://localhost:18789',
  gatewayToken: 'test-token',
  gatewayTlsFingerprint: 'AA'.repeat(32),
});
const mapping = { agentId: 'agent', sessionKey: 'agent:agent:main' };
const gateways: OpenClawGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  transport.requests.length = 0;
  transport.responses = {};
  transport.response = {};
  transport.connections = 0;
  transport.failures = {};
  transport.handler = null;
  transport.files.clear();
  vi.useRealTimers();
});
function fixture() {
  const gateway = new OpenClawGateway(config());
  gateways.push(gateway);
  gateway.start();
  gateway.ready = true;
  return gateway;
}
describe('official Gateway wire projections', () => {
  it('retains only scoped verified capabilities for offline use and bounds/clears the cache', async () => {
    const gateway = fixture();
    await gateway.models();
    expect(gateway.cachedModels(mapping)).toBeNull();
    transport.responses['chat.history'] = {
      messages: [],
      sessionInfo: { model: 'model', modelProvider: 'mock' },
    };
    await gateway.history(mapping);
    const verified = await gateway.models(mapping);
    gateway.ready = false;
    expect(gateway.cachedModels(mapping)).toEqual(verified);
    expect(
      gateway.cachedModels({ ...mapping, agentId: 'different' }),
    ).toBeNull();
    const copied = gateway.cachedModels(mapping);
    if (copied?.[0]) copied[0].input = [];
    expect(gateway.cachedModels(mapping)?.[0]?.input).toEqual([
      'text',
      'image',
    ]);
    gateway.ready = true;
    for (let index = 0; index < 10; index++) {
      const scope = {
        agentId: `agent-${index}`,
        sessionKey: `agent:agent-${index}:main`,
      };
      await gateway.history(scope);
      await gateway.models(scope);
    }
    expect(gateway.cachedModels(mapping)).toBeNull();
    const newest = { agentId: 'agent-9', sessionKey: 'agent:agent-9:main' };
    transport.responses['agents.delete'] = { ok: true };
    transport.responses['agents.list'] = { agents: [] };
    await gateway.remove(newest);
    expect(gateway.cachedModels(newest)).toBeNull();
  });
  it('fences delayed model reads after confirmed deletion without evicting active capability scopes', async () => {
    const gateway = fixture();
    const catalog = {
      models: [
        {
          id: 'model',
          name: 'Mock model',
          provider: 'mock',
          input: ['text', 'image'],
        },
      ],
    };
    const history = {
      messages: [],
      sessionInfo: { model: 'model', modelProvider: 'mock' },
    };
    transport.responses['chat.history'] = history;
    await gateway.history(mapping);
    await gateway.models(mapping);
    const active = Array.from({ length: 10 }, (_, index) => ({
      agentId: `active-${index}`,
      sessionKey: `agent:active-${index}:main`,
    }));
    for (const scope of active.slice(0, 9)) {
      await gateway.history(scope);
      await gateway.models(scope);
    }
    let resolveModels!: (value: unknown) => void;
    let resolveHistory!: (value: unknown) => void;
    transport.handler = (method, raw) => {
      if (method === 'models.list') {
        const scope = z.object({ agentId: z.string() }).parse(raw);
        if (scope.agentId === mapping.agentId)
          return new Promise<unknown>((resolve) => {
            resolveModels = resolve;
          });
        return catalog;
      }
      if (method === 'agents.delete') return { ok: true };
      if (method === 'agents.list')
        return { agents: active.map((scope) => ({ id: scope.agentId })) };
      if (method === 'chat.history') {
        const scope = z.object({ agentId: z.string() }).parse(raw);
        if (scope.agentId === mapping.agentId)
          return new Promise<unknown>((resolve) => {
            resolveHistory = resolve;
          });
        return history;
      }
      throw new Error(`Unexpected method ${method}`);
    };
    const delayed = gateway.models(mapping);
    const delayedHistory = gateway.history(mapping);
    await gateway.remove(mapping);
    const newest = active[9];
    if (!newest) throw new Error('Missing active scope');
    await gateway.history(newest);
    await gateway.models(newest);
    resolveModels(catalog);
    resolveHistory(history);
    expect(await delayed).toHaveLength(1);
    await delayedHistory;
    expect(gateway.cachedModels(mapping)).toBeNull();
    for (const scope of active)
      expect(gateway.cachedModels(scope)?.[0]?.id).toBe('mock/model');
    transport.handler = (method) =>
      method === 'models.list' ? catalog : history;
    await gateway.models(mapping);
    expect(gateway.cachedModels(mapping)).toBeNull();
    for (const scope of active)
      expect(gateway.cachedModels(scope)?.[0]?.id).toBe('mock/model');
  });
  it('dispatches independent chat sends while agent creation is waiting', async () => {
    const gateway = fixture();
    let finishCreation!: (value: unknown) => void;
    transport.handler = (method, params) => {
      if (method === 'agents.create')
        return new Promise<unknown>((resolve) => {
          finishCreation = resolve;
        });
      if (method === 'chat.send')
        return {
          runId: z.object({ idempotencyKey: z.string() }).parse(params)
            .idempotencyKey,
          status: 'started',
        };
      return transport.responses[method];
    };
    transport.responses = {
      'models.list': { models: [] },
      'agents.list': { agents: [{ id: 'messenger-new' }] },
      'sessions.create': { ok: true, key: 'agent:messenger-new:main' },
      'sessions.patch': {
        ok: true,
        entry: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
          fastMode: false,
        },
        resolved: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
        },
      },
      'chat.history': {
        messages: [],
        sessionInfo: { model: 'model', modelProvider: 'mock' },
        thinkingLevel: 'off',
        fastMode: false,
      },
      'sessions.messages.subscribe': { ok: true },
    };
    const creation = gateway.create('new', {
      model: 'mock/model',
      thinkingLevel: 'off',
      fastMode: false,
    });
    await Promise.resolve();
    const sent = await Promise.all([
      gateway.send(mapping, 'first', 'One', 'queue'),
      gateway.send(
        { agentId: 'other', sessionKey: 'agent:other:main' },
        'second',
        'Two',
        'queue',
      ),
    ]);
    expect(sent.map((result) => result.runId)).toEqual(['first', 'second']);
    expect(
      transport.requests.filter(
        (request) => request.method === 'sessions.create',
      ),
    ).toHaveLength(0);
    finishCreation({ ok: true, agentId: 'messenger-new' });
    await creation;
  });
  it('releases the configuration gate after an uncertain creation error without replaying it', async () => {
    const gateway = fixture();
    transport.failures['agents.create'] = [new Error('Uncertain creation')];
    transport.responses = {
      'agents.create': { ok: true, agentId: 'messenger-next' },
      'agents.list': { agents: [{ id: 'messenger-next' }] },
      'sessions.create': { ok: true, key: 'agent:messenger-next:main' },
      'sessions.patch': {
        ok: true,
        entry: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
          fastMode: false,
        },
        resolved: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
        },
      },
      'chat.history': {
        messages: [],
        sessionInfo: { model: 'model', modelProvider: 'mock' },
        thinkingLevel: 'off',
        fastMode: false,
      },
      'sessions.messages.subscribe': { ok: true },
    };
    const settings = {
      model: 'mock/model',
      thinkingLevel: 'off',
      fastMode: false,
    };
    const first = gateway.create('first', settings);
    const next = gateway.create('next', settings);
    await expect(first).rejects.toThrow('Uncertain creation');
    expect((await next).agentId).toBe('messenger-next');
    expect(
      transport.requests
        .filter((request) => request.method === 'agents.create')
        .map((request) => request.params),
    ).toEqual([
      { name: 'messenger-first', model: 'mock/model' },
      { name: 'messenger-next', model: 'mock/model' },
    ]);
  });
  it('serializes agent configuration changes through session initialization for ten creations', async () => {
    const gateway = fixture();
    const agents = new Set<string>();
    let currentAgent: string | null = null;
    transport.handler = (method, raw) => {
      const params = z
        .object({
          name: z.string().optional(),
          agentId: z.string().optional(),
          key: z.string().optional(),
        })
        .parse(raw);
      switch (method) {
        case 'agents.create': {
          const agentId = params.name ?? '';
          agents.add(agentId);
          currentAgent = agentId;
          return { ok: true, agentId };
        }
        case 'agents.list':
          return { agents: [...agents].map((id) => ({ id })) };
        case 'sessions.create': {
          if (currentAgent !== params.agentId)
            throw Object.assign(
              new Error('Agent database target changed before creating open'),
              {
                code: 'UNAVAILABLE',
                name: 'SessionMutationFactsUnavailableError',
              },
            );
          return { ok: true, key: params.key };
        }
        case 'sessions.patch':
          return {
            ok: true,
            entry: {
              model: 'model',
              modelProvider: 'mock',
              thinkingLevel: 'off',
              fastMode: false,
            },
            resolved: {
              model: 'model',
              modelProvider: 'mock',
              thinkingLevel: 'off',
            },
          };
        case 'chat.history':
          return {
            messages: [],
            sessionInfo: { model: 'model', modelProvider: 'mock' },
            thinkingLevel: 'off',
            fastMode: false,
          };
        case 'sessions.messages.subscribe':
          currentAgent = null;
          return { ok: true };
        case 'models.list':
          return {
            models: [
              {
                id: 'model',
                name: 'Mock model',
                provider: 'mock',
                input: ['text', 'image'],
              },
            ],
          };
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    };
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        gateway.create(`creation-${index}`, {
          model: 'mock/model',
          thinkingLevel: 'off',
          fastMode: false,
        }),
      ),
    );
    expect(created).toHaveLength(10);
    expect(new Set(created.map((item) => item.agentId)).size).toBe(10);
    expect(
      transport.requests.filter(
        (request) => request.method === 'agents.create',
      ),
    ).toHaveLength(10);
    expect(
      transport.requests.filter(
        (request) => request.method === 'sessions.create',
      ),
    ).toHaveLength(10);
  });
  it('prepares titles with the selected chat agent and model, preserving an unavailable result', async () => {
    const gateway = fixture();
    transport.responses['sessions.title.prepare'] = { title: 'Prepared title' };
    expect(await gateway.title(mapping, 'mock/model', 'first message')).toBe(
      'Prepared title',
    );
    expect(transport.requests).toEqual([
      {
        method: 'sessions.title.prepare',
        params: {
          agentId: mapping.agentId,
          model: 'mock/model',
          message: 'first message',
        },
      },
    ]);
    transport.responses['sessions.title.prepare'] = { title: null };
    expect(
      await gateway.title(mapping, 'mock/model', 'first message'),
    ).toBeNull();
  });
  it('looks up an incomplete creation without changing sessions or settings', async () => {
    const gateway = fixture();
    const id = 'incomplete';
    const agentId = `messenger-${id}`;
    transport.responses['agents.list'] = { agents: [{ id: agentId }] };
    expect(await gateway.lookupCreation(id)).toEqual({
      agentId,
      sessionKey: `agent:${agentId}:main`,
    });
    expect(transport.requests).toEqual([{ method: 'agents.list', params: {} }]);
  });
  it('submits supported files through chat.send and rejects expanded payloads before the RPC', async () => {
    const gateway = fixture();
    transport.response = { runId: 'run', status: 'started' };
    const attachment = {
      type: 'file' as const,
      mimeType: 'text/plain',
      fileName: 'note.txt',
      content: Buffer.from('text token').toString('base64'),
      sizeBytes: 10,
      origin: 'file' as const,
    };
    await gateway.send(mapping, 'submission', '', 'queue', [attachment]);
    expect(transport.requests.at(-1)).toEqual({
      method: 'chat.send',
      params: {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
        message: '',
        idempotencyKey: 'submission',
        queueMode: 'followup',
        attachments: [attachment],
      },
    });
    gateway.maxPayload = 1024;
    await expect(
      gateway.send(mapping, 'oversized', 'x'.repeat(1024), 'queue'),
    ).rejects.toMatchObject({ code: 'GATEWAY_PAYLOAD_LIMIT' });
    expect(transport.requests).toHaveLength(1);
  });
  it('requests tool events and projects actual agent wire events safely', () => {
    const gateway = fixture();
    expect(transport.options?.caps).toContain('tool-events');
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));
    transport.options?.onEvent?.({
      type: 'event',
      event: 'agent',
      payload: {
        stream: 'tool',
        sessionKey: mapping.sessionKey,
        runId: 'run',
        seq: 3,
        data: {
          phase: 'start',
          toolCallId: 'call',
          name: 'write',
          args: { path: 'note.txt', content: '<script>alert(1)</script>' },
        },
      },
    });
    expect(events[0]).toMatchObject({
      type: 'tool',
      sessionKey: mapping.sessionKey,
      sequence: 3,
      tool: { name: 'write', status: 'running' },
    });
  });
  it.each([
    {
      metadata: { runId: 'native-run' },
      topLevel: undefined,
      expected: 'native-run',
    },
    {
      metadata: { runId: 'native-run' },
      topLevel: 'non-authoritative-top-level',
      expected: 'native-run',
    },
    {
      metadata: {},
      topLevel: 'compatibility-run',
      expected: 'compatibility-run',
    },
    { metadata: {}, topLevel: undefined, expected: undefined },
  ])(
    'preserves authoritative nested native run identity with top-level compatibility fallback: $expected',
    async ({ metadata, topLevel, expected }) => {
      const gateway = fixture();
      transport.responses['chat.history'] = {
        messages: [
          {
            role: 'assistant',
            content: 'Canonical response',
            runId: topLevel,
            __openclaw: { id: 'message', seq: 4, ...metadata },
          },
        ],
        sessionInfo: { model: 'model', modelProvider: 'mock' },
      };
      const history = await gateway.history(mapping);
      expect(history.messages[0]?.runId).toBe(expected);
      expect(history.messages[0]?.id).toBe('message');
    },
  );
  it('rejects malformed nested run metadata instead of inventing a canonical identity', async () => {
    const gateway = fixture();
    transport.responses['chat.history'] = {
      messages: [
        { role: 'assistant', content: 'Response', __openclaw: { runId: 42 } },
      ],
      sessionInfo: { model: 'model', modelProvider: 'mock' },
    };
    expect((await gateway.history(mapping)).messages).toEqual([]);
  });
  // Value: canonical tool messages otherwise bypass ToolActivity redaction and can
  // expose credentials in both recent snapshots and older history pages.
  it.each(
    ['tool', 'toolResult'].flatMap((role) =>
      ['string', 'blocks'].flatMap((contentShape) =>
        [undefined, 'older:50'].map((cursor) => ({
          role,
          contentShape,
          cursor,
        })),
      ),
    ),
  )(
    'redacts canonical $role $contentShape content on page $cursor while preserving display identity',
    async ({ role, contentShape, cursor }) => {
      const gateway = fixture();
      const bearer = ['fixture', 'authorization', 'value'].join('-');
      const providerKey = ['sk', 'fixtureproviderkey'].join('-');
      const alternateKey = ['sk', 'ant', 'fixturealternatekey'].join('-');
      const ordinary = '<script>read("note.txt")</script>\nSaved\tfile';
      const sensitive = `${ordinary}\nBearer ${bearer}; ${providerKey}; ${alternateKey}`;
      transport.responses['chat.history'] = {
        sessionInfo: { model: 'model', modelProvider: 'mock' },
        messages: [
          {
            role,
            toolCallId: 'canonical-call',
            toolName: 'read',
            runId: 'compatibility-run',
            __openclaw: {
              id: 'canonical-tool',
              runId: 'native-run',
              seq: 17,
              recordTimestampMs: 1234,
            },
            content:
              contentShape === 'string'
                ? sensitive
                : [
                    { type: 'text', text: ordinary },
                    { type: 'image', text: 'non-text display block' },
                    { type: 'text', text: sensitive.slice(ordinary.length) },
                  ],
          },
          { id: 'user', role: 'user', content: sensitive },
          { id: 'assistant', role: 'assistant', content: sensitive },
        ],
      };
      const history = await gateway.history(mapping, cursor ? { cursor } : {});
      const { text, ...identity } = history.messages[0]!;
      // Boolean assertions keep synthetic credential values out of failure output.
      expect(
        text === `${ordinary}\nBearer [redacted]; [redacted]; [redacted]`,
      ).toBe(true);
      expect(
        [bearer, providerKey, alternateKey].some((secret) =>
          text.includes(secret),
        ),
      ).toBe(false);
      expect(history.messages[1]?.text === sensitive).toBe(true);
      expect(history.messages[2]?.text === sensitive).toBe(true);
      expect(identity).toEqual({
        id: 'canonical-tool',
        role: 'tool',
        toolCallId: 'canonical-call',
        toolName: 'read',
        runId: 'native-run',
        historySequence: 17,
        createdAt: 1234,
      });
    },
  );
  // Value: untrusted canonical tool output gets the same preview size/control
  // character policy as live tools, without changing readable user/assistant text.
  it('bounds canonical tool text and strips unsafe controls without changing ordinary text', async () => {
    const gateway = fixture();
    const ordinary = '<b>literal markup</b>\nline\tcolumn\rreturn';
    const unsafe = `${ordinary}\u0000\u0001\u001b\u007f`;
    transport.responses['chat.history'] = {
      sessionInfo: { model: 'model', modelProvider: 'mock' },
      messages: [
        { role: 'tool', content: unsafe },
        { role: 'toolResult', content: 'x'.repeat(9000) },
        { role: 'tool', content: ordinary },
        { role: 'user', content: unsafe },
        { role: 'assistant', content: 'x'.repeat(9000) },
      ],
    };
    const history = await gateway.history(mapping);
    expect(history.messages[0]?.text === ordinary).toBe(true);
    expect(history.messages[1]?.text.length).toBe(8192);
    expect(history.messages[2]?.text === ordinary).toBe(true);
    expect(history.messages[3]?.text === unsafe).toBe(true);
    expect(history.messages[4]?.text.length).toBe(9000);
  });
  // Value: cutting a provider key before redaction can leave a short key fragment
  // below the redactor's minimum match length at the tool preview boundary.
  it.each(
    ['tool', 'toolResult'].flatMap((role) =>
      ['provider', 'alternate'].map((keyKind) => ({ role, keyKind })),
    ),
  )(
    'redacts $keyKind keys before cutting $role text at the preview boundary',
    async ({ role, keyKind }) => {
      const gateway = fixture();
      const keyPrefix =
        keyKind === 'provider'
          ? ['sk', ''].join('-')
          : ['sk', 'ant', ''].join('-');
      const key = `${keyPrefix}${['fixture', 'boundary', 'value'].join('')}`;
      const prefix = `${'x'.repeat(8192 - keyPrefix.length - 5)} `;
      const sensitive = `${prefix}${key} readable tail`;
      transport.responses['chat.history'] = {
        sessionInfo: { model: 'model', modelProvider: 'mock' },
        messages: [
          {
            role,
            content:
              role === 'tool' ? sensitive : [{ type: 'text', text: sensitive }],
          },
          { role: 'user', content: sensitive },
          { role: 'assistant', content: sensitive },
        ],
      };
      const history = await gateway.history(mapping);
      expect(
        history.messages[0]?.text ===
          `${prefix}[redacted] readable tail`.slice(0, 8192),
      ).toBe(true);
      expect(history.messages[0]?.text.includes(`${keyPrefix}fixt`)).toBe(
        false,
      );
      expect(history.messages[0]?.text.length).toBe(8192);
      expect(history.messages[1]?.text === sensitive).toBe(true);
      expect(history.messages[2]?.text === sensitive).toBe(true);
    },
  );
  it('preserves authoritative transcript identities across history windows and restores tools', async () => {
    const gateway = fixture();
    const message = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call',
          name: 'write',
          arguments: { path: 'note.txt' },
        },
      ],
      __openclaw: { id: 'canonical-message', seq: 20, recordTimestampMs: 1234 },
    };
    transport.responses['chat.history'] = {
      messages: [
        { role: 'user', content: 'earlier' },
        message,
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'write',
          __openclaw: { runId: 'native-run' },
          content: [{ type: 'text', text: 'Saved' }],
        },
      ],
      sessionInfo: { model: 'model', modelProvider: 'mock' },
      inFlightRun: {
        runId: 'active',
        events: [
          {
            stream: 'tool',
            sessionKey: mapping.sessionKey,
            runId: 'active',
            seq: 1,
            data: {
              phase: 'start',
              toolCallId: 'active-call',
              name: 'read',
              args: { path: 'note.txt' },
            },
          },
        ],
      },
    };
    const first = await gateway.history(mapping);
    expect(first.messages[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call',
      toolName: 'write',
      runId: 'native-run',
    });
    expect(first.messages[1]).toMatchObject({
      id: 'canonical-message',
      createdAt: 1234,
    });
    expect(first.tools?.find((tool) => tool.name === 'write')).toMatchObject({
      status: 'completed',
      output: 'Saved',
    });
    expect(first.tools?.find((tool) => tool.name === 'read')).toMatchObject({
      status: 'running',
    });
    transport.responses['chat.history'] = {
      messages: [message],
      sessionInfo: { model: 'model', modelProvider: 'mock' },
    };
    expect(
      (await gateway.history(mapping, { cursor: 'older:50' })).messages[0]?.id,
    ).toBe(first.messages[1]?.id);
  });
  it('keeps newly generated workspace documents resolvable when native artifacts fill the catalog limit', async () => {
    const gateway = fixture();
    const agentId = 'messenger-00000000-0000-4000-8000-000000000000';
    const target = { agentId, sessionKey: `agent:${agentId}:main` };
    const document = {
      id: new WorkspaceArtifacts(undefined).id(target, 'documents/report.txt'),
      name: 'report.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      sourcePath: 'documents/report.txt',
    };
    const listing = vi
      .spyOn(WorkspaceArtifacts.prototype, 'list')
      .mockResolvedValue([document]);
    transport.responses['artifacts.list'] = {
      artifacts: Array.from({ length: 100 }, (_, i) => ({
        id: `native-${i}`,
        title: `native-${i}.txt`,
        sessionKey: target.sessionKey,
        download: { mode: 'bytes' },
      })),
    };
    try {
      const artifacts = await gateway.artifacts(target);
      expect(artifacts).toHaveLength(100);
      expect(artifacts[0]).toEqual(document);
      expect(
        await gateway.resolveArtifact(target, 'documents/report.txt'),
      ).toEqual(document);
    } finally {
      listing.mockRestore();
    }
  });
  it('uses scoped official artifact methods, decodes bytes and rejects cross-chat downloads', async () => {
    const gateway = fixture();
    const upstream = {
      id: 'native:artifact',
      title: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      sessionKey: mapping.sessionKey,
      download: { mode: 'bytes' },
    };
    transport.responses = {
      'artifacts.list': { artifacts: [upstream] },
      'artifacts.download': {
        artifact: upstream,
        encoding: 'base64',
        data: 'cG5n',
      },
    };
    const catalog = await gateway.artifacts(mapping);
    expect(transport.requests[0]).toEqual({
      method: 'artifacts.list',
      params: { sessionKey: mapping.sessionKey, agentId: mapping.agentId },
    });
    expect(
      (await gateway.artifact(mapping, catalog[0]?.id ?? '')).bytes.toString(),
    ).toBe('png');
    expect(transport.requests[2]).toEqual({
      method: 'artifacts.download',
      params: {
        sessionKey: mapping.sessionKey,
        agentId: mapping.agentId,
        artifactId: upstream.id,
      },
    });
    transport.responses['artifacts.download'] = {
      artifact: { ...upstream, sessionKey: 'other-agent' },
      encoding: 'base64',
      data: 'cG5n',
    };
    await expect(
      gateway.artifact(mapping, catalog[0]?.id ?? ''),
    ).rejects.toMatchObject({ status: 404 });
    transport.failures['artifacts.download'] = [
      Object.assign(new Error('private upstream details'), {
        code: 'INVALID_REQUEST',
        details: { type: 'artifact_not_found' },
      }),
    ];
    await expect(
      gateway.artifact(mapping, catalog[0]?.id ?? ''),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    transport.failures['artifacts.download'] = [
      Object.assign(new Error('private upstream details'), {
        code: 'INVALID_REQUEST',
        details: { type: 'artifact_download_unsupported' },
      }),
    ];
    await expect(
      gateway.artifact(mapping, catalog[0]?.id ?? ''),
    ).rejects.toMatchObject({
      status: 422,
      code: 'ARTIFACT_DOWNLOAD_UNSUPPORTED',
    });
  });
  it('retries only pending exact-identity pairing and stops after a bounded window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01'));
    fixture();
    const identity = transport.options?.deviceIdentity;
    transport.options?.onReconnectPaused?.({
      code: 1008,
      reason: 'Pairing pending',
      detailCode: 'PAIRING_REQUIRED',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.connections).toBe(2);
    expect(transport.options?.deviceIdentity).toBe(identity);
    expect(transport.options?.scopes).toEqual([
      'operator.read',
      'operator.write',
      'operator.admin',
    ]);
    await vi.advanceTimersByTimeAsync(180_000);
    transport.options?.onReconnectPaused?.({
      code: 1008,
      reason: 'Pairing pending',
      detailCode: 'PAIRING_REQUIRED',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.connections).toBe(2);
  });
  it('keeps invalid authentication paused instead of retrying it', async () => {
    vi.useFakeTimers();
    fixture();
    transport.options?.onReconnectPaused?.({
      code: 1008,
      reason: 'Invalid authentication',
      detailCode: 'AUTH_TOKEN_MISMATCH',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.connections).toBe(1);
  });
  it('recovers only the exact creation identity and adopts its canonical main session', async () => {
    const gateway = fixture();
    const id = 'e1c56838-7e73-4ac9-aa22-41808d8f9dc8';
    const agentId = `messenger-${id}`;
    transport.responses = {
      'agents.list': {
        agents: [{ id: 'unrelated', name: agentId }, { id: agentId }],
      },
      'sessions.create': { ok: true, key: `agent:${agentId}:main` },
      'sessions.patch': {
        ok: true,
        entry: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
          fastMode: false,
        },
        resolved: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
        },
      },
      'chat.history': {
        messages: [],
        sessionInfo: { model: 'model', modelProvider: 'mock' },
        thinkingLevel: 'off',
        fastMode: false,
      },
      'sessions.messages.subscribe': { ok: true },
    };
    const desired = {
      model: 'mock/model',
      thinkingLevel: 'off',
      fastMode: false,
      customInstructions: 'Keep examples brief.',
      responseStyle: 'concise' as const,
      personality: 'direct' as const,
    };
    const recovered = await gateway.recoverCreation(id, desired);
    expect(recovered).toEqual({ agentId, sessionKey: `agent:${agentId}:main` });
    expect(
      transport.requests.some((request) => request.method === 'agents.create'),
    ).toBe(false);
    expect(
      transport.requests.find((request) => request.method === 'sessions.create')
        ?.params,
    ).toEqual({
      agentId,
      key: `agent:${agentId}:main`,
      idempotencyKey: id,
      model: 'mock/model',
      thinkingLevel: 'off',
      fastMode: false,
      permissionMode: 'workspace',
    });
    expect(transport.files.get(agentId)).toContain(desired.customInstructions);
    expect((await gateway.history(recovered ?? mapping)).settings).toEqual(
      settingsSchema.parse(desired),
    );
    expect(
      transport.requests.find(({ method }) => method === 'agents.files.set')
        ?.params,
    ).toMatchObject({
      agentId,
      name: 'AGENTS.md',
      expectedMissing: true,
    });
    expect(transport.files.has('unrelated')).toBe(false);
    expect(await gateway.exists(recovered ?? mapping)).toBe(true);
    expect(transport.requests.at(-1)?.method).toBe('agents.list');
  });
  it('waits for agent hot reload and retries only the exact unknown-agent rejection', async () => {
    vi.useFakeTimers();
    const gateway = fixture();
    const id = 'pending';
    const agentId = `messenger-${id}`;
    let rosterReads = 0;
    transport.responses = {
      'agents.create': { ok: true, agentId },
      'sessions.create': { ok: true, key: `agent:${agentId}:main` },
      'sessions.patch': {
        ok: true,
        entry: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
          fastMode: false,
        },
        resolved: {
          model: 'model',
          modelProvider: 'mock',
          thinkingLevel: 'off',
        },
      },
      'chat.history': {
        messages: [],
        sessionInfo: { model: 'model', modelProvider: 'mock' },
        thinkingLevel: 'off',
        fastMode: false,
      },
      'sessions.messages.subscribe': { ok: true },
    };
    Object.defineProperty(transport.responses, 'agents.list', {
      get: () => ({ agents: ++rosterReads === 1 ? [] : [{ id: agentId }] }),
    });
    transport.failures['sessions.create'] = [
      Object.assign(
        new Error(
          `Unknown agent id "${agentId}". Run openclaw agents list to see configured agents.`,
        ),
        { code: 'INVALID_REQUEST' },
      ),
    ];
    const created = gateway.create(id, {
      model: 'mock/model',
      thinkingLevel: 'off',
      fastMode: false,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await created).toEqual({
      agentId,
      sessionKey: `agent:${agentId}:main`,
    });
    expect(
      transport.requests.filter(
        (request) => request.method === 'agents.create',
      ),
    ).toHaveLength(1);
    const sessions = transport.requests.filter(
      (request) => request.method === 'sessions.create',
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.params).toEqual(sessions[1]?.params);
  });
  it('reports missing creation identities without mutating other agents', async () => {
    const gateway = fixture();
    transport.responses['agents.list'] = { agents: [{ id: 'unrelated' }] };
    expect(
      await gateway.recoverCreation('missing', {
        model: 'mock/model',
        thinkingLevel: 'off',
        fastMode: false,
      }),
    ).toBeNull();
    expect(await gateway.exists(mapping)).toBe(false);
    expect(transport.requests.map((request) => request.method)).toEqual([
      'agents.list',
      'agents.list',
    ]);
  });
  it('uses authoritative offsets for older history, never the forward delta cursor', async () => {
    const gateway = fixture();
    transport.response = {
      sessionId: 'canonical-session',
      messages: [
        {
          id: 'message',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          timestamp: 123,
        },
      ],
      sessionInfo: { modelProvider: 'mock', model: 'model' },
      thinkingLevel: 'off',
      fastMode: false,
      hasMore: true,
      nextOffset: 50,
      deltaCursor: 'forward-catch-up',
    };
    const history = await gateway.history(mapping);
    expect(history.sessionId).toBe('canonical-session');
    expect(history.historyCursor).toBe('older:50');
    expect(history.messages[0]?.text).toBe('hello');
    await gateway.history(mapping, {
      cursor: history.historyCursor ?? '',
      inputRunIds: [],
    });
    const historyReads = transport.requests.filter(
      ({ method }) => method === 'chat.history',
    );
    expect(historyReads).toEqual([
      {
        method: 'chat.history',
        params: {
          sessionKey: mapping.sessionKey,
          agentId: mapping.agentId,
          limit: 50,
          maxBytes: 262144,
        },
      },
      {
        method: 'chat.history',
        params: {
          sessionKey: mapping.sessionKey,
          agentId: mapping.agentId,
          limit: 50,
          maxBytes: 262144,
          offset: 50,
        },
      },
    ]);
    expect(
      transport.requests.filter(({ method }) => method === 'agents.files.get'),
    ).toEqual([
      {
        method: 'agents.files.get',
        params: { agentId: mapping.agentId, name: 'AGENTS.md' },
      },
      {
        method: 'agents.files.get',
        params: { agentId: mapping.agentId, name: 'AGENTS.md' },
      },
    ]);
    const confirmedRequests = [...transport.requests];
    await expect(
      gateway.history(mapping, { cursor: 'forward-catch-up' }),
    ).rejects.toThrow('history page');
    expect(transport.requests).toEqual(confirmedRequests);
  });
  it('projects cumulative message updates as replacements and deltaText as appends', () => {
    const gateway = fixture();
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));
    transport.options?.onEvent?.({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: mapping.sessionKey,
        runId: 'run',
        seq: 1,
        state: 'delta',
        deltaText: 'hello ',
      },
    });
    transport.options?.onEvent?.({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: mapping.sessionKey,
        runId: 'run',
        seq: 2,
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello world' }],
        },
      },
    });
    expect(
      events.map((event) =>
        event.type === 'chat'
          ? { text: event.text, replace: event.replace }
          : null,
      ),
    ).toEqual([
      { text: 'hello ', replace: false },
      { text: 'hello world', replace: true },
    ]);
  });
});
