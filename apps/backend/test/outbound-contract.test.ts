import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ChatSnapshot, ConversationEvent } from '@messenger/contracts';
import { Store } from '../src/database.js';
import { ChatService, mapping } from '../src/chats/service.js';
import {
  OutboundContractError,
  ApplicationError,
  toProblem,
} from '../src/errors.js';
import { parseOutboundEvent, parseOutboundFrame } from '../src/outbound.js';
import { FakeGateway, testSettings } from './fake-gateway.js';

const resources: { store: Store; service: ChatService }[] = [];
afterEach(async () => {
  for (const { store, service } of resources.splice(0)) {
    service.close();
    await service.drain();
    store.close();
  }
});
async function fixture() {
  const store = new Store(':memory:');
  const gateway = new FakeGateway();
  const service = new ChatService(store, gateway);
  resources.push({ store, service });
  const chat = await service.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  await service.drain();
  return {
    store,
    gateway,
    service,
    chat,
    snapshot: await service.snapshot(chat.id),
  };
}

describe('outbound conversation contracts', () => {
  // Test value: protects=canonical tool redaction across cached snapshots and history frames;
  // fails_when=message projection sends raw tool text; why_new=live tool activity is a separate path;
  // seam=none; no_claim=provider-key discovery outside the shared redaction policy.
  it('redacts cached canonical tool messages and every history response while retaining message metadata and ordinary user text', async () => {
    const f = await fixture();
    const bearer = 'synthetic-bearer-value';
    const providerKey = `sk-${'synthetic'.repeat(3)}`;
    const text = `Visible notes. Bearer ${bearer} ${providerKey} end.\u0001`;
    const tool = {
      id: 'canonical-tool',
      role: 'tool' as const,
      text,
      createdAt: 123,
      toolCallId: 'call',
      toolName: 'read' as const,
      runId: 'run',
      historySequence: 7,
      artifacts: [
        { id: 'file', name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5 },
      ],
    };
    const expectedTool = {
      ...tool,
      text: 'Visible notes. Bearer [redacted] [redacted] end.',
    };
    const user = { id: 'user', role: 'user' as const, text, createdAt: 100 };
    const assistant = {
      id: 'assistant',
      role: 'assistant' as const,
      text,
      createdAt: 101,
    };
    const unsafe = { ...f.snapshot, messages: [tool, user, assistant] };
    f.store.db
      .prepare(
        'INSERT INTO chat_history VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json',
      )
      .run(f.chat.id, JSON.stringify(unsafe));
    f.gateway.ready = false;
    const cached = await f.service.snapshot(f.chat.id);
    expect(cached.messages).toEqual([expectedTool, user, assistant]);

    const event = parseOutboundEvent({
      type: 'conversation.snapshot',
      generation: 'generation',
      sequence: 1,
      snapshot: unsafe,
    });
    if (event.type !== 'conversation.snapshot')
      throw new Error('Expected snapshot event');
    expect(event.snapshot.messages).toEqual([expectedTool, user, assistant]);
    const frame = parseOutboundFrame({
      type: 'command.result',
      commandId: 'history',
      ok: true,
      data: {
        snapshot: unsafe,
        snapshots: [unsafe],
        messages: unsafe.messages,
      },
    });
    if (frame.type !== 'command.result' || !frame.ok)
      throw new Error('Expected successful history result');
    expect(frame.data?.messages).toEqual([expectedTool, user, assistant]);
    expect(frame.data?.snapshot?.messages).toEqual([
      expectedTool,
      user,
      assistant,
    ]);
    expect(frame.data?.snapshots?.[0]?.messages).toEqual([
      expectedTool,
      user,
      assistant,
    ]);
    expect(JSON.stringify(cached.messages[0])).not.toContain(bearer);
    expect(JSON.stringify(cached.messages[0])).not.toContain(providerKey);
  });

  it('validates every event variant and both command outcomes, including bounded projection markers', async () => {
    const f = await fixture();
    const snapshot: ChatSnapshot = {
      ...f.snapshot,
      activeRun: { id: 'run', text: 'preview', sequence: 1, truncated: true },
      hiddenPendingCount: 3,
    };
    const order = { generation: 'generation', sequence: 0 };
    const tool = {
      id: 'run:call',
      name: 'search',
      status: 'completed' as const,
      parameters: '{}',
      output: 'done',
    };
    const events: ConversationEvent[] = [
      { ...order, type: 'connection.state', state: 'ready' },
      { ...order, type: 'conversation.snapshot', snapshot },
      { ...order, type: 'conversation.updated', chat: f.snapshot.chat },
      { ...order, type: 'conversation.deleted', chatId: f.chat.id },
      {
        ...order,
        type: 'conversation.run.text',
        chatId: f.chat.id,
        runId: 'run',
        text: 'preview',
        runSequence: 1,
        replace: true,
        truncated: true,
      },
      { ...order, type: 'conversation.tool', chatId: f.chat.id, tool },
    ];
    for (const event of events)
      expect(parseOutboundEvent(event)).toEqual(event);
    for (const frame of [
      ...events,
      {
        type: 'command.result',
        commandId: 'command',
        ok: true,
        data: {
          snapshot,
          snapshots: [snapshot],
          messages: [],
          messageId: 'message',
          historyCursor: null,
          hasOlderHistory: false,
        },
      },
      {
        type: 'command.result',
        commandId: 'command',
        ok: false,
        error: toProblem(
          new ApplicationError(409, 'CONFLICT', 'Reload before retrying.'),
          'correlation',
        ),
      },
    ])
      expect(parseOutboundFrame(frame)).toEqual(frame);
    expect(
      parseOutboundFrame({ ...events[0], upstreamToken: 'never-projected' }),
    ).not.toHaveProperty('upstreamToken');
  });

  it('rejects malformed nested events and results as safe internal errors, not client validation errors', async () => {
    const f = await fixture();
    const malformed = [
      { type: 'invented', generation: 'g', sequence: 1 },
      {
        type: 'connection.state',
        generation: 'g',
        sequence: NaN,
        state: 'ready',
      },
      {
        type: 'conversation.snapshot',
        generation: 'g',
        sequence: 1,
        snapshot: { ...f.snapshot, hiddenPendingCount: -1 },
      },
      {
        type: 'conversation.tool',
        generation: 'g',
        sequence: 1,
        chatId: f.chat.id,
        tool: {
          id: 'call',
          name: 'tool',
          status: 'invented',
          parameters: 'secret-internal-value',
          output: '',
        },
      },
      {
        type: 'conversation.run.text',
        generation: 'g',
        sequence: 1,
        chatId: f.chat.id,
        runId: 'run',
        text: 'x'.repeat(256 * 1024 + 1),
        replace: true,
        runSequence: 1,
      },
      {
        type: 'command.result',
        commandId: 'command',
        ok: true,
        data: { snapshot: {} },
      },
      {
        type: 'command.result',
        commandId: 'command',
        ok: false,
        error: { status: 200 },
      },
    ];
    for (const frame of malformed) {
      expect(() => parseOutboundFrame(frame)).toThrow(OutboundContractError);
      try {
        parseOutboundFrame(frame);
      } catch (error) {
        const problem = toProblem(error, 'correlation');
        expect(problem.status).toBe(500);
        expect(problem.code).toBe('OUTBOUND_CONTRACT_INVALID');
        expect(problem.detail).toContain('Reconnect');
        expect(JSON.stringify(problem)).not.toContain('secret-internal-value');
      }
    }
    expect(
      toProblem(
        new ApplicationError(NaN, 'bad', 'private error'),
        'correlation',
      ),
    ).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred.',
    });
  });

  it('rejects an actual malformed Gateway publication before delivery and emits a single safe unavailable event', async () => {
    const f = await fixture();
    const runId = randomUUID();
    await f.service.command({
      type: 'conversation.message.send',
      commandId: runId,
      chatId: f.chat.id,
      text: 'retained input',
    });
    await f.service.drain();
    const frames: ConversationEvent[] = [];
    f.service.onEvent((event) => frames.push(event));
    f.gateway.emit({
      type: 'chat',
      sessionKey: mapping(f.store.getChat(f.chat.id)).sessionKey,
      runId,
      state: 'delta',
      text: 'secret-invalid-preview',
      replace: false,
      sequence: NaN,
    });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({
      type: 'connection.state',
      state: 'unavailable',
    });
    expect(f.store.pending(f.chat.id)).toHaveLength(1);
    expect(f.gateway.sends).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toContain('secret-invalid-preview');
  });

  it('isolates failed subscribers without rejecting accepted work or starving other subscribers', async () => {
    const f = await fixture();
    let calls = 0;
    f.service.onEvent(() => {
      calls++;
      throw new Error('listener failure');
    });
    const frames: ConversationEvent[] = [];
    f.service.onEvent((event) => frames.push(event));
    f.gateway.emit({ type: 'connection', ready: false });
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'connection.state',
      state: 'unavailable',
    });
    const commandId = randomUUID();
    expect(
      await f.service.command({
        type: 'conversation.message.send',
        commandId,
        chatId: f.chat.id,
        text: 'retained despite subscriber failure',
      }),
    ).toMatchObject({ ok: true });
    expect(
      f.store.pending(f.chat.id).some((item) => item.id === commandId),
    ).toBe(true);
    expect(frames.some((event) => event.type === 'conversation.snapshot')).toBe(
      true,
    );
  });
});
