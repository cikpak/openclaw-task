import type {
  ConversationCommand,
  ConversationFrame,
  ChatSnapshot,
} from '@messenger/contracts';
import { vi } from 'vitest';
import { frameValid } from '../lib/validation';
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
  commands: ConversationCommand[] = [];
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
    const command = JSON.parse(raw) as ConversationCommand;
    this.commands.push(command);
    if (
      this.autoSnapshots &&
      command.type === 'conversation.snapshot.request'
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
    this.onmessage?.({ data: JSON.stringify(frame) });
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
