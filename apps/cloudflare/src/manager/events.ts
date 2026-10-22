import type { ConversationEvent } from '@messenger/contracts';
import { parseOutboundEvent } from '../../../backend/src/outbound.js';
import type { Store } from '../../../backend/src/storage/store.js';
import type { ManagerAuthorization } from './authorization.js';
import type { SocketAuthorization } from './socket-auth.js';

/** One durable stream identity covers cached events and native-service events. */
export class ManagerEvents {
  constructor(
    private readonly state: DurableObjectState,
    private readonly store: Store,
    private readonly authorization: ManagerAuthorization,
    private readonly sockets: SocketAuthorization,
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS manager_stream (id INTEGER PRIMARY KEY CHECK(id = 1), generation TEXT NOT NULL, sequence INTEGER NOT NULL)',
    );
    store.db
      .prepare('INSERT OR IGNORE INTO manager_stream VALUES (1, ?, 0)')
      .run(crypto.randomUUID());
  }
  private frame(value: ConversationEvent): ConversationEvent {
    return this.store.db.transaction(() => {
      const stream = this.store.db
        .prepare('SELECT generation, sequence FROM manager_stream WHERE id = 1')
        .get() as { generation: string; sequence: number };
      const event = parseOutboundEvent({
        ...value,
        generation: stream.generation,
        sequence: stream.sequence + 1,
      });
      this.store.db
        .prepare('UPDATE manager_stream SET sequence = ? WHERE id = 1')
        .run(event.sequence);
      return event;
    })();
  }
  connection(socket: WebSocket): void {
    const event = this.frame({
      type: 'connection.state',
      state: 'ready',
      generation: 'manager',
      sequence: 0,
    });
    socket.send(JSON.stringify(event));
  }
  publish(value: ConversationEvent): void {
    let event: ConversationEvent;
    try {
      event = this.frame(value);
    } catch {
      return;
    }
    const chatId =
      'chatId' in event
        ? event.chatId
        : 'chat' in event
          ? event.chat.id
          : 'snapshot' in event
            ? event.snapshot.chat.id
            : undefined;
    for (const socket of this.state.getWebSockets()) {
      const grant = this.sockets.live(socket);
      if (
        !grant ||
        (chatId && !this.authorization.owns('chat', chatId, grant.accountId))
      )
        continue;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        /* Retained state supports reconnect. */
      }
    }
  }
}
