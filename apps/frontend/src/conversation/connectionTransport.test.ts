import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatProjection } from '../state/stores';
import type { ConnectionState } from './connectionCommands';
import { startConnection } from './connectionTransport';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const ticket = (value = 'fresh-ticket') => ({
  ticket: value,
  address: '/ws/conversation',
  expiresAt: Date.now() + 60000,
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
let state: ConnectionState;
let stop: (() => void) | undefined;
const refresh = vi.fn(() => Promise.resolve());
const send = vi.fn(() => Promise.resolve({}));
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  refresh.mockClear();
  useChatProjection.getState().clear();
  state = {
    socket: { current: null },
    pending: { current: new Map() },
    completed: { current: new Set() },
    snapshotOrder: { current: 0 },
  };
  vi.stubGlobal('WebSocket', Socket);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});
it('gets a fresh credentialed POST ticket for every initial connection and reconnect', async () => {
  let sequence = 0;
  const fetcher = vi.fn(() =>
    Promise.resolve(response(ticket(`ticket-${++sequence}`))),
  );
  vi.stubGlobal('fetch', fetcher);
  stop = startConnection(state, send, refresh);
  await settle();
  expect(Socket.instances).toHaveLength(1);
  const first = Socket.instances[0]!;
  const url = new URL(first.url);
  expect(url.host).toBe(location.host);
  expect(url.pathname).toBe('/ws/conversation');
  expect(url.searchParams.get('ticket')).toBe('ticket-1');
  expect(fetcher).toHaveBeenCalledWith(
    '/api/connection-tickets',
    expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal) as AbortSignal,
    }),
  );
  first.close(1006);
  await vi.advanceTimersByTimeAsync(1000);
  expect(Socket.instances).toHaveLength(2);
  expect(new URL(Socket.instances[1]!.url).searchParams.get('ticket')).toBe(
    'ticket-2',
  );
});
it.each([401, 403])(
  'refreshes authentication on ticket rejection %s before retrying with a fresh ticket',
  async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ detail: 'Sign in' }, status))
      .mockImplementation(() => Promise.resolve(response(ticket())));
    vi.stubGlobal('fetch', fetcher);
    stop = startConnection(state, send, refresh);
    await settle();
    expect(refresh).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Socket.instances).toHaveLength(1);
  },
);
it('retries ticket service failures without opening an unauthorized socket', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(() => Promise.resolve(response(ticket())));
  vi.stubGlobal('fetch', fetcher);
  stop = startConnection(state, send, refresh);
  await settle();
  expect(Socket.instances).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(Socket.instances).toHaveLength(1);
});
it.each([
  { ...ticket(), address: 'wss://external.example/ws/conversation' },
  { ...ticket(), expiresAt: 0 },
  { ...ticket(), ticket: '' },
])('rejects malformed, foreign, or expired ticket responses', async (data) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(response(data))),
  );
  stop = startConnection(state, send, refresh);
  await settle();
  expect(Socket.instances).toHaveLength(0);
});
it('aborts a pending ticket and discards its late response after unmount', async () => {
  let complete!: (value: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  stop = startConnection(state, send, refresh);
  const options = (
    fetcher.mock.calls[0] as unknown as [string, RequestInit]
  )[1];
  stop();
  expect(options.signal?.aborted).toBe(true);
  complete(response(ticket()));
  await settle();
  expect(Socket.instances).toHaveLength(0);
});
it.each([1008, 4001])(
  'refreshes auth on authorization closure %s and cancels pending reconnects on disposal',
  async (code) => {
    const fetcher = vi.fn(() => Promise.resolve(response(ticket())));
    vi.stubGlobal('fetch', fetcher);
    stop = startConnection(state, send, refresh);
    await settle();
    Socket.instances[0]!.close(code);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Socket.instances).toHaveLength(2);
    stop();
    stop = startConnection(state, send, refresh);
    await settle();
    Socket.instances[2]!.close(1006);
    stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
