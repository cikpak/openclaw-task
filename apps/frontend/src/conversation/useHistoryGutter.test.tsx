import { act, render, screen } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useHistoryGutter } from './useHistoryGutter';

let outer = 1000;
let inner = 984;
let renders = 0;
const observers: Array<{
  callback: () => void;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];
beforeEach(() => {
  outer = 1000;
  inner = 984;
  renders = 0;
  observers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(public callback: () => void) {
        observers.push(this);
      }
    },
  );
});
function Harness() {
  renders++;
  const history = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useHistoryGutter(history, body);
  return (
    <div ref={body} data-testid="body">
      <div
        data-testid="history"
        ref={(node) => {
          history.current = node;
          if (node)
            Object.defineProperties(node, {
              offsetWidth: { configurable: true, get: () => outer },
              clientWidth: { configurable: true, get: () => inner },
            });
        }}
      />
    </div>
  );
}
const gutter = () =>
  screen.getByTestId('body').style.getPropertyValue('--chat-scrollbar-gutter');

it('shares classic scrollbar space synchronously before paint', () => {
  render(<Harness />);
  expect(gutter()).toBe('16px');
  expect(observers[0]?.observe).toHaveBeenCalledWith(
    screen.getByTestId('history'),
  );
});

it('does not reserve extra width for overlay scrollbars', () => {
  inner = outer;
  render(<Harness />);
  expect(gutter()).toBe('0px');
});

it('updates only changed measurements without rerendering the chat', () => {
  render(<Harness />);
  const writes = vi.spyOn(screen.getByTestId('body').style, 'setProperty');
  const initialRenders = renders;
  act(() => observers[0]!.callback());
  expect(writes).not.toHaveBeenCalled();
  inner = 985;
  act(() => observers[0]!.callback());
  expect(gutter()).toBe('15px');
  expect(writes).toHaveBeenCalledOnce();
  expect(renders).toBe(initialRenders);
});

it('cleans up observers and ignores queued callbacks after unmount', () => {
  const { unmount } = render(<Harness />);
  const body = screen.getByTestId('body');
  const writes = vi.spyOn(body.style, 'setProperty');
  unmount();
  expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
  inner = 990;
  observers[0]!.callback();
  expect(writes).not.toHaveBeenCalled();
  expect(body.style.getPropertyValue('--chat-scrollbar-gutter')).toBe('');
});

it('falls back to a cleaned-up resize listener without ResizeObserver', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  const { unmount } = render(<Harness />);
  expect(gutter()).toBe('16px');
  inner = outer;
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  expect(gutter()).toBe('0px');
  const remove = vi.spyOn(window, 'removeEventListener');
  unmount();
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
});

it('keeps the correct gutter under StrictMode and bounds invalid widths', () => {
  render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  expect(gutter()).toBe('16px');
  expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
  inner = outer + 1;
  act(() => observers.at(-1)!.callback());
  expect(gutter()).toBe('0px');
});
