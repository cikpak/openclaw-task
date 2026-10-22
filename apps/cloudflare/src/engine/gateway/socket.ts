import type {
  GatewayProtocolSocket,
  GatewayProtocolSocketHandlers,
} from '@openclaw/gateway-client/browser';
export function socketFactory(
  port: Fetcher,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  let ws: WebSocket | undefined;
  let closed = false;
  let closeNotified = false;
  const notifyClose = (code: number, reason: string) => {
    if (closeNotified) return;
    closeNotified = true;
    try {
      handlers.close(code, reason);
    } catch {
      /* A socket may already be closed; notifications remain best effort. */
    }
  };
  const pending = new AbortController();
  const limit = 8388608;
  const closeSocket = (
    socket: WebSocket,
    code = 1000,
    reason = 'Private transport closed',
  ) => {
    try {
      socket.close(code, reason);
    } catch {
      /* A socket may already be closed; notifications remain best effort. */
    }
  };
  const invoke = (callback: () => void) => {
    if (!closed) {
      try {
        callback();
      } catch (error) {
        fail(error);
      }
    }
  };
  const fail = (error: unknown) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    pending.abort();
    if (ws) closeSocket(ws, 1011, 'Private transport failed');
    try {
      handlers.error(
        error instanceof Error ? error : new Error('Private transport failed'),
      );
    } catch {
      /* A socket may already be closed; notifications remain best effort. */
    }
    notifyClose(1006, 'Private transport failed');
  };
  const timer = setTimeout(
    () => fail(new Error('Private WebSocket upgrade deadline exceeded')),
    10000,
  );
  void port
    .fetch('http://openclaw-gateway/', {
      headers: { Upgrade: 'websocket' },
      signal: pending.signal,
    })
    .then(async (response) => {
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        await response.body?.cancel();
        throw new Error(`Private WebSocket upgrade HTTP ${response.status}`);
      }
      ws = socket;
      if (closed) {
        socket.accept();
        closeSocket(socket);
        return;
      }
      clearTimeout(timer);
      socket.addEventListener('message', (event) =>
        invoke(() => {
          if (
            typeof event.data !== 'string' ||
            new TextEncoder().encode(event.data).length > limit
          )
            throw new Error('Invalid or oversized Gateway frame');
          handlers.message(event.data);
        }),
      );
      socket.addEventListener('error', () =>
        fail(new Error('Private WebSocket error')),
      );
      socket.addEventListener('close', (event) => {
        closed = true;
        clearTimeout(timer);
        notifyClose(event.code, event.reason);
      });
      socket.accept();
      invoke(handlers.open);
    })
    .catch(fail);
  return {
    isOpen: () => !closed && ws?.readyState === WebSocket.OPEN,
    send: (data) => {
      if (closed || ws?.readyState !== WebSocket.OPEN)
        throw new Error('Private transport is not open');
      if (new TextEncoder().encode(data).length > limit) {
        fail(new Error('Oversized outgoing Gateway frame'));
        throw new Error('Oversized outgoing Gateway frame');
      }
      ws.send(data);
    },
    close: (code, reason) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      pending.abort();
      if (ws) closeSocket(ws, code, reason);
      queueMicrotask(() =>
        notifyClose(code ?? 1000, reason ?? 'Private transport closed'),
      );
    },
  };
}
