import { registerConnectionTickets } from '../auth/connection-tickets.js';
import { parseOutboundFrame } from '../outbound.js';
import { commandSchema } from '../schemas.js';
import { ValidationError, toProblem } from '../errors.js';
import type { WebSocket } from 'ws';
import type { LegacyContext } from './context.js';

export function registerConversation(context: LegacyContext) {
  const {
    app,
    config,
    store,
    chats,
    gateway,
    sessionId,
    sessionSockets,
    protectedRoute,
  } = context;
  const consumeConnectionTicket = registerConnectionTickets(
    app,
    sessionId,
    config.origin,
  );
  app.get(
    '/ws/conversation',
    { websocket: true, preHandler: [protectedRoute, consumeConnectionTicket] },
    (socket, request) => {
      if (request.headers.origin !== config.origin) {
        socket.close(1008, 'Origin rejected');
        return;
      }
      const id = sessionId(request);
      const sockets = sessionSockets.get(id) ?? new Set<WebSocket>();
      sockets.add(socket);
      sessionSockets.set(id, sockets);
      function send(frame: unknown): void {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1048576) {
          socket.close(1013, 'Resynchronize');
          return;
        }
        try {
          socket.send(JSON.stringify(parseOutboundFrame(frame)));
        } catch {
          request.log.error(
            { code: 'OUTBOUND_CONTRACT_INVALID' },
            'Outbound conversation frame rejected',
          );
          socket.close(1011, 'Reconnect to refresh');
        }
      }
      const expiry = setTimeout(
        () => socket.close(1008, 'Session expired'),
        Math.max(0, (request.session.get('expiresAt') ?? 0) - Date.now()),
      );
      expiry.unref();
      const unsubscribe = chats.onEvent((event) => {
        if (!store.sessionValid(id)) {
          socket.close(1008, 'Session expired');
          return;
        }
        send(event);
      });
      send({
        type: 'connection.state',
        state: gateway.ready && chats.reconciled ? 'ready' : 'unavailable',
        generation: chats.generation,
        sequence: 0,
      });
      socket.on('message', (raw) => {
        void (async () => {
          if (!store.sessionValid(id)) {
            socket.close(1008, 'Session expired');
            return;
          }
          let command;
          try {
            const bytes = Array.isArray(raw)
              ? Buffer.concat(raw)
              : raw instanceof ArrayBuffer
                ? Buffer.from(raw)
                : raw;
            command = commandSchema.parse(JSON.parse(bytes.toString('utf8')));
          } catch {
            send({
              type: 'command.result',
              commandId: 'invalid',
              ok: false,
              error: toProblem(new ValidationError(), request.id),
            });
            return;
          }
          const result = await chats.command(command);
          send(result);
        })().catch(() => socket.close(1011, 'Connection failed'));
      });
      socket.on('close', () => {
        clearTimeout(expiry);
        unsubscribe();
        sockets.delete(socket);
        if (sockets.size === 0) sessionSockets.delete(id);
      });
    },
  );
}
