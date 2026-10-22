import { expect, it } from 'vitest';
import { Store } from '../src/database.js';
import { ChatService } from '../src/chats/service.js';
import { enqueue } from '../src/chats/queue.js';
import { GatewayFacade } from '../src/gateway/facade.js';
import type { GatewayFiles, GatewayTransport } from '../src/gateway/context.js';
import { normalizedTestSettings } from './fake-gateway.js';

it.each([
  { completed: false, nativeConsumed: false },
  { completed: false, nativeConsumed: true },
  { completed: true, nativeConsumed: false },
  { completed: true, nativeConsumed: true },
])(
  'requires native execution completion after reconstruction (%j), keeping proofs private',
  async ({ completed, nativeConsumed }) => {
    const store = new Store(':memory:');
    const mapping = { agentId: 'agent-a', sessionKey: 'agent:agent-a:main' };
    const requests: string[] = [];
    const transport: GatewayTransport = {
      ready: true,
      stopped: false,
      maxPayload: 8388608,
      start() {},
      stop: () => Promise.resolve(),
      request: (method) => {
        requests.push(method);
        if (method === 'agents.files.get')
          return Promise.resolve({
            agentId: mapping.agentId,
            file: { name: 'AGENTS.md', missing: true },
          });
        if (method === 'chat.history')
          return Promise.resolve({
            ...mapping,
            sessionId: 'native-session',
            sessionInfo: {
              sessionId: 'native-session',
              model: 'model',
              modelProvider: 'test',
            },
            hasMore: false,
            inputReceipts: nativeConsumed
              ? [
                  {
                    runId: 'input',
                    state: 'consumed',
                    consumedByEventId: 'canonical-event',
                  },
                ]
              : [],
            messages: [
              {
                role: 'user',
                content: 'Exact accepted input',
                __openclaw: {
                  id: 'canonical-event',
                  seq: 1,
                  idempotencyKey: 'input:user',
                  messengerProcessing: {
                    runId: 'generated-owner',
                    keys: ['input:user'],
                  },
                },
              },
              ...(completed
                ? [
                    {
                      role: 'assistant',
                      content: 'Completed output',
                      stopReason: 'stop',
                      __openclaw: {
                        id: 'assistant-event',
                        seq: 2,
                        runId: 'generated-owner',
                      },
                    },
                  ]
                : []),
            ],
          });
        return Promise.resolve({});
      },
    };
    const files: GatewayFiles = {
      list: () => Promise.resolve([]),
      handles: () => false,
      download: () => Promise.reject(new Error('No files')),
      sourcePath: () => '',
    };
    const gateway = new GatewayFacade(transport, files);
    const service = new ChatService(store, gateway, undefined, {
      backgroundReconciliation: false,
    });
    try {
      store.reserveChat({
        id: 'chat',
        creationId: 'create',
        name: 'Chat',
        status: 'recovery',
        ...mapping,
        version: 1,
        unread: false,
        createdAt: 1,
        updatedAt: 1,
        settings: normalizedTestSettings,
      });
      const input = enqueue(store, {
        type: 'conversation.message.send',
        commandId: 'input',
        chatId: 'chat',
        text: 'Exact accepted input',
      });
      input.state = 'unknown';
      store.savePending(input);
      store.saveSubmissionScope(input.id, 'native-session');
      expect(service.terminalRuns.size).toBe(0);
      await service.reconcile();
      await service.drain();
      const snapshot = service.cachedSnapshot('chat');
      expect(snapshot.chat.status).toBe(completed ? 'idle' : 'recovery');
      if (completed) expect(snapshot.pending).toEqual([]);
      else
        expect(snapshot.pending).toMatchObject([
          { id: 'input', state: 'unknown' },
        ]);
      expect(snapshot.messages.map((message) => message.text)).toEqual(
        completed
          ? ['Exact accepted input', 'Completed output']
          : ['Exact accepted input'],
      );
      expect(requests).not.toContain('chat.send');
      expect(JSON.stringify(snapshot)).not.toContain('completedInputs');
      expect(JSON.stringify(snapshot)).not.toContain('nativeInputOwners');
      expect(JSON.stringify(snapshot)).not.toContain('messengerProcessing');
      expect(JSON.stringify(snapshot)).not.toContain('idempotencyKey');
      expect(JSON.stringify(snapshot)).not.toContain('input:user');
    } finally {
      service.close();
      await service.drain();
      store.close();
    }
  },
);
