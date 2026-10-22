import { registerApplicationDispatcher } from '../lib/manager';
import { ApiError, request } from '../lib/api';
import { record } from '../lib/validation';
import { useChatProjection } from '../state/stores';
import { failPending } from './connectionCommands';
import type { ConnectionState, Send } from './connectionCommands';
import { refreshConnectionCatalog } from './connectionCatalog';
import { connectionFrames } from './connectionFrames';

export async function connectionAddress(signal: AbortSignal): Promise<string> {
  const { data } = await request('/api/connection-tickets', {
    method: 'POST',
    signal,
  });
  if (
    !record(data) ||
    typeof data.ticket !== 'string' ||
    !data.ticket ||
    data.ticket.length > 4096 ||
    data.address !== '/ws/conversation' ||
    typeof data.expiresAt !== 'number' ||
    !Number.isFinite(data.expiresAt) ||
    data.expiresAt <= Date.now()
  ) {
    throw new Error('The connection could not be authorized.');
  }
  const address = new URL(data.address, location.origin);
  address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  address.searchParams.set('ticket', data.ticket);
  return address.toString();
}

export function startConnection(
  state: ConnectionState,
  send: Send,
  refresh: () => Promise<void>,
) {
  let disposed = false;
  let unregister: (() => void) | undefined;
  let retry: number | undefined;
  let epoch = 0;
  let attempts = 0;
  let controller: AbortController | undefined;
  let frames: ReturnType<typeof connectionFrames> | undefined;
  const schedule = () => {
    if (!disposed)
      retry = window.setTimeout(
        () => {
          void connect();
        },
        Math.min(1000 * 2 ** attempts++, 15000),
      );
  };
  const reauthenticate = () => {
    // A grant can expire while the browser session remains valid. Refreshing
    // authentication must still allow a fresh-ticket reconnect in that case.
    void refresh().then(schedule, schedule);
  };
  async function connect() {
    if (disposed) return;
    const connectionEpoch = ++epoch;
    const current = () => !disposed && connectionEpoch === epoch;
    controller?.abort();
    controller = new AbortController();
    useChatProjection.getState().beginConnection();
    let address: string;
    try {
      address = await connectionAddress(controller.signal);
    } catch (error) {
      if (!current()) return;
      useChatProjection.getState().markUnavailable();
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        reauthenticate();
      } else schedule();
      return;
    }
    if (!current()) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(address);
    } catch {
      useChatProjection.getState().markUnavailable();
      schedule();
      return;
    }
    state.socket.current = ws;
    frames = connectionFrames(state, send, ws, current);
    ws.onopen = () => {
      if (!current()) return;
      attempts = 0;
      unregister?.();
      unregister = registerApplicationDispatcher(send);
      useChatProjection.getState().markTransportOpen();
      void refreshConnectionCatalog(ws, send, current);
    };
    ws.onerror = () => {
      if (current()) useChatProjection.getState().markUnavailable();
    };
    ws.onclose = (event) => {
      if (!current()) return;
      unregister?.();
      state.socket.current = null;
      frames?.flush();
      frames?.dispose();
      useChatProjection.getState().markTransportClosed();
      useChatProjection.getState().markUnavailable();
      failPending(state);
      if (event.code === 1008 || event.code === 4001) {
        reauthenticate();
        return;
      }
      schedule();
    };
  }
  void connect();
  return () => {
    disposed = true;
    unregister?.();
    epoch++;
    controller?.abort();
    if (retry !== undefined) window.clearTimeout(retry);
    frames?.dispose();
    state.socket.current?.close();
    state.socket.current = null;
    failPending(state);
  };
}
