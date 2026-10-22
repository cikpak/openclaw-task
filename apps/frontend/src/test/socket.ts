import type {
  ManagerCommand,
  ConversationFrame,
  ChatSnapshot,
} from '@messenger/contracts';
import { vi } from 'vitest';
import { frameValid } from '../lib/validation';
import { ApiError } from '../lib/api';
import { fixtureApplication } from './applicationDispatcher';
import { snapshot } from './fixtures';

export class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  static snapshots: ChatSnapshot[] | null = null;
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  commands: ManagerCommand[] = [];
  autoSnapshots = true;
  constructor() {
    TestSocket.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.();
      this.receive({
        type: 'connection.state',
        generation: 'test',
        sequence: 0,
        state: 'ready',
      });
    });
  }
  send(raw: string) {
    const command = JSON.parse(raw) as ManagerCommand;
    this.commands.push(command);
    if (
      this.autoSnapshots &&
      (command.type === 'conversation.snapshot.request' ||
        command.type === 'conversation.recent.request')
    ) {
      const snapshots = TestSocket.snapshots ?? [
        snapshot,
        {
          ...snapshot,
          chat: { ...snapshot.chat, id: 'chat-b', name: 'Writing' },
        },
      ];
      const selected = snapshots.find(
        (item) => item.chat.id === command.chatId,
      );
      queueMicrotask(() =>
        this.receive({
          type: 'command.result',
          commandId: command.commandId,
          ok: true,
          data:
            command.chatId && selected ? { snapshot: selected } : { snapshots },
        }),
      );
    }
    if (!command.type.startsWith('conversation.')) {
      void fixtureApplication(command).then(
        (data) =>
          this.receive({
            type: 'command.result',
            commandId: command.commandId,
            ok: true,
            data,
          }),
        (error: unknown) =>
          this.receive({
            type: 'command.result',
            commandId: command.commandId,
            ok: false,
            error: {
              type: 'about:blank',
              title: 'Fixture request failed',
              correlationId: 'test',
              status: error instanceof ApiError ? error.status : 500,
              code: error instanceof ApiError ? error.code : 'REQUEST_FAILED',
              detail: error instanceof Error ? error.message : 'Fixture failed',
            },
          }),
      );
    }
    if (command.type === 'conversation.message.read')
      queueMicrotask(() =>
        this.receive({
          type: 'command.result',
          commandId: command.commandId,
          ok: true,
          data: {},
        }),
      );
  }
  receive(frame: ConversationFrame) {
    if (!frameValid(frame)) throw new Error('Invalid fixture');
    const raw = JSON.stringify(frame);
    if (raw.length <= 16000) this.onmessage?.({ data: raw });
    else {
      const id = crypto.randomUUID();
      const count = Math.ceil(raw.length / 16000);
      for (let index = 0; index < count; index++)
        this.onmessage?.({
          data: JSON.stringify({
            type: 'manager.chunk',
            id,
            index,
            count,
            text: raw.slice(index * 16000, (index + 1) * 16000),
          }),
        });
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
export function installTestSocket() {
  TestSocket.instances = [];
  TestSocket.snapshots = null;
  vi.stubGlobal('WebSocket', TestSocket);
}
export function currentSocket() {
  const socket = TestSocket.instances.at(-1);
  if (!socket) throw new Error('Socket not initialized');
  return socket;
}

export function testConnectionTicket() {
  return {
    ticket: crypto.randomUUID(),
    address: '/ws/conversation',
    expiresAt: Date.now() + 60000,
  };
}
