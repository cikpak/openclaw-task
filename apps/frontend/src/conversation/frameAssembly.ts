import { record } from '../lib/validation';
/** WS order permits one append per fragment; no completed-message retention cap. */
export function frameAssembly(now: () => number = Date.now) {
  const streams = new Map<
    string,
    { count: number; chunks: string[]; expiresAt: number }
  >();
  return (value: unknown): unknown => {
    for (const [id, stream] of streams)
      if (stream.expiresAt <= now()) streams.delete(id);
    if (!record(value) || value.type !== 'manager.chunk') return value;
    if (
      typeof value.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(value.id) ||
      !Number.isSafeInteger(value.index) ||
      !Number.isSafeInteger(value.count) ||
      Number(value.count) < 1 ||
      typeof value.text !== 'string' ||
      value.text.length > 16 * 1024
    )
      return undefined;
    const index = Number(value.index),
      count = Number(value.count);
    let stream = streams.get(value.id);
    if (!stream) {
      if (index !== 0 || streams.size >= 2) return undefined;
      stream = { count, chunks: [], expiresAt: now() + 360000 };
      streams.set(value.id, stream);
    }
    if (
      stream.count !== count ||
      index !== stream.chunks.length ||
      index >= count
    ) {
      streams.delete(value.id);
      return undefined;
    }
    stream.chunks.push(value.text);
    if (stream.chunks.length !== count) return undefined;
    streams.delete(value.id);
    try {
      return JSON.parse(stream.chunks.join(''));
    } catch {
      return undefined;
    }
  };
}
