import { describe, expect, it } from 'vitest';
import { frameAssembly } from './frameAssembly';
const fragments = (value: unknown, id = 'transfer-1') => {
  const text = JSON.stringify(value);
  const count = Math.ceil(text.length / 16384);
  return Array.from({ length: count }, (_, index) => ({
    type: 'manager.chunk',
    id,
    index,
    count,
    text: text.slice(index * 16384, (index + 1) * 16384),
  }));
};
describe('manager frame assembly', () => {
  it.each([2530000, 8400000])(
    'retains all %i completed characters including surrogate boundaries',
    (size) => {
      const original = {
        type: 'command.result',
        data: { messages: [{ text: '🧵'.repeat(size / 2) + 'end' }] },
      };
      const assemble = frameAssembly();
      let result: unknown;
      for (const fragment of fragments(original)) result = assemble(fragment);
      expect(result).toEqual(original);
    },
  );
  it('rejects missing, duplicate, conflicting and expired fragments', () => {
    let now = 0;
    const assemble = frameAssembly(() => now);
    const [first, second] = fragments({ text: 'a'.repeat(20000) });
    expect(assemble(second)).toBeUndefined();
    expect(assemble(first)).toBeUndefined();
    expect(assemble(first)).toBeUndefined();
    expect(assemble(second)).toBeUndefined();
    expect(assemble(first)).toBeUndefined();
    expect(assemble({ ...second, count: 3 })).toBeUndefined();
    expect(assemble(first)).toBeUndefined();
    now = 360001;
    expect(assemble(second)).toBeUndefined();
  });
  it('limits concurrent transfers and individual fragment allocation', () => {
    const assemble = frameAssembly();
    const [first] = fragments({ text: 'a'.repeat(20000) });
    assemble(first);
    assemble({ ...first, id: 'transfer-2' });
    expect(
      assemble({ ...first, id: 'transfer-3', count: 1, text: '{}' }),
    ).toBeUndefined();
    expect(assemble({ ...first, text: 'x'.repeat(16385) })).toBeUndefined();
  });
});
