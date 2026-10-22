import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../backend/src/database.js';
import { FileReaders } from './readers.js';
import { BrowserBoundary } from './boundary.js';
import { lifecycleFixture } from '../engine/lifecycle/fixture.js';
const closes: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of closes.splice(0)) close();
});
it('pins live sources and objects across service reconstruction, releasing only after body completion', async () => {
  const store = new Store(':memory:');
  closes.push(() => store.close());
  const first = new FileReaders(store);
  const id = first.admit(true, 'files/current');
  const again = new FileReaders(store);
  expect(again.live()).toBe(true);
  expect(again.keys().has('files/current')).toBe(true);
  expect(again.beginDelete('files/current')).toBe(false);
  let release!: () => void;
  const input = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      controller.enqueue(new TextEncoder().encode('exact-current-file'));
      controller.close();
    },
  });
  const response = new Response(first.stream(input, id));
  const result = response.text();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(again.live()).toBe(true);
  release();
  expect(await result).toBe('exact-current-file');
  expect(again.live()).toBe(false);
  expect(again.beginDelete('files/current')).toBe(true);
  expect(() => again.admit(false, 'files/current')).toThrow();
  again.endDelete('files/current');
  expect(again.admit(false, 'files/current')).toBeTypeOf('string');
});
it('keeps the live source pinned throughout bounded audited header acquisition', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  closes.push(() => store.close());
  const readers = new FileReaders(store);
  const id = readers.admit(true, null);
  await vi.advanceTimersByTimeAsync(119_000);
  // The helper header deadline is120s; initial durable allowance is180s.
  expect(readers.live()).toBe(true);
  const body = readers.stream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('audited current bytes'));
        controller.close();
      },
    }),
    id,
  );
  expect(await new Response(body).text()).toBe('audited current bytes');
  expect(readers.live()).toBe(false);
});
it('moves the durable lease to the body deadline before a delayed first read', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  closes.push(() => store.close());
  const readers = new FileReaders(store);
  const id = readers.admit(true, null);
  await vi.advanceTimersByTimeAsync(119_000);
  const body = readers.stream(new ReadableStream<Uint8Array>(), id);
  await vi.advanceTimersByTimeAsync(89_000);
  expect(readers.live()).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(readers.live()).toBe(false);
  await expect(new Response(body).text()).rejects.toThrow('timed out');
});
it('times out stalled readers independently of session expiry and prunes stale durable leases', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  closes.push(() => store.close());
  const readers = new FileReaders(store);
  const id = readers.admit(true, 'files/a');
  const cancel = vi.fn();
  const body = readers.stream(new ReadableStream({ cancel }), id);
  await vi.advanceTimersByTimeAsync(91_000);
  expect(readers.live()).toBe(false);
  expect(cancel).toHaveBeenCalled();
  await expect(new Response(body).text()).rejects.toThrow('timed out');
});
it('holds the synchronous final stop fence for live readers without waking or cancelling capture', async () => {
  const f = lifecycleFixture();
  closes.push(() => f.close());
  await f.wake();
  f.time += 60_001;
  await f.until('committing');
  let active = true;
  f.driver.canStop = () => !active;
  await f.core.tick();
  expect(f.core.status).toBe('committing');
  expect(f.core.state.wantWake).toBe(false);
  expect(f.calls).not.toContain('destroy');
  active = false;
  await f.core.tick();
  expect(f.core.status).toBe('asleep');
  expect(f.calls).toContain('destroy');
});
it('projects canonical pending text, metadata, errors and replay without changing private inputs or opaque links', () => {
  const boundary = new BrowserBoundary(() => ({
    documentsRoots: [],
    publications: [],
    secrets: ['opaque-credential'],
  }));
  const input = {
    chat: { id: 'chat-id', name: '/recovery/private/AGENTS.md' },
    pending: [
      {
        text: 'Read /recovery/private/credentials.json token=PRIVATE_VALUE opaque-credential',
      },
    ],
    error: { detail: 'AGENTS.md at /recovery/x' },
    download: { url: `/downloads/${'a'.repeat(64)}` },
  };
  const output = boundary.project(input);
  const json = JSON.stringify(output);
  expect(json).not.toContain('/recovery');
  expect(json).not.toContain('AGENTS.md');
  expect(json).not.toContain('PRIVATE_VALUE');
  expect(json).not.toContain('opaque-credential');
  expect(output.chat.id).toBe('chat-id');
  expect(output.download.url).toBe(input.download.url);
  expect(input.pending[0]!.text).toContain(
    '/recovery/private/credentials.json',
  );
});
