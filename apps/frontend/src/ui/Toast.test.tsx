import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Toast } from './Toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function advance(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}
function setup() {
  const dismiss = vi.fn();
  const view = render(<Toast text="Preferences saved." onDismiss={dismiss} />);
  return { ...view, dismiss, toast: screen.getByRole('group') };
}

it('starts its exit after three seconds without moving focus and dismisses after motion', () => {
  const { toast, dismiss } = setup();
  const focus = document.activeElement;
  advance(2999);
  expect(toast).not.toHaveAttribute('data-closing');
  advance(1);
  expect(toast).toHaveAttribute('data-closing', 'true');
  expect(dismiss).not.toHaveBeenCalled();
  advance(180);
  expect(dismiss).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(focus);
});

it('keeps a focused notification visible and resumes only its remaining time', () => {
  const { toast, dismiss } = setup();
  advance(1200);
  act(() => toast.focus());
  advance(10000);
  expect(dismiss).not.toHaveBeenCalled();
  expect(toast).not.toHaveAttribute('data-closing');
  act(() => toast.blur());
  advance(1799);
  expect(toast).not.toHaveAttribute('data-closing');
  advance(1);
  expect(toast).toHaveAttribute('data-closing', 'true');
  advance(180);
  expect(dismiss).toHaveBeenCalledOnce();
});

it('moving focus between the container and dismiss button remains paused', () => {
  const { toast, dismiss } = setup();
  advance(1000);
  act(() => toast.focus());
  act(() => screen.getByRole('button').focus());
  advance(7000);
  expect(dismiss).not.toHaveBeenCalled();
  act(() => toast.focus());
  advance(7000);
  expect(dismiss).not.toHaveBeenCalled();
  act(() => toast.blur());
  advance(2000);
  expect(toast).toHaveAttribute('data-closing', 'true');
});

it('focus arriving during automatic exit cancels dismissal and the closing animation', () => {
  const { toast, dismiss } = setup();
  advance(3000);
  advance(90);
  act(() => toast.focus());
  expect(toast).not.toHaveAttribute('data-closing');
  advance(5000);
  expect(dismiss).not.toHaveBeenCalled();
  act(() => toast.blur());
  advance(0);
  expect(toast).toHaveAttribute('data-closing', 'true');
  advance(180);
  expect(dismiss).toHaveBeenCalledOnce();
});

it('manual dismissal remains available while focused', () => {
  const { dismiss } = setup();
  const button = screen.getByRole('button', { name: 'Dismiss notification' });
  act(() => button.focus());
  fireEvent.click(button);
  advance(180);
  expect(dismiss).toHaveBeenCalledOnce();
});

it('reduced motion dismisses without a visual exit delay', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  const { dismiss } = setup();
  advance(3000);
  advance(0);
  expect(dismiss).toHaveBeenCalledOnce();
});

it('unmounting clears lifetime and exit timers', () => {
  const first = setup();
  first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const second = setup();
  advance(3000);
  second.unmount();
  expect(vi.getTimerCount()).toBe(0);
  advance(10000);
  expect(first.dismiss).not.toHaveBeenCalled();
  expect(second.dismiss).not.toHaveBeenCalled();
});

it('rerenders do not restart lifetime and use the latest dismissal callback', () => {
  const { rerender, dismiss } = setup();
  advance(2000);
  const latest = vi.fn();
  rerender(<Toast text="Settings saved." onDismiss={latest} />);
  advance(1000);
  advance(180);
  expect(latest).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
});

it('independent notifications expire on independent lifetimes', () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = render(<Toast key="a" text="First" onDismiss={first} />);
  advance(1000);
  rerender(
    <>
      <Toast key="a" text="First" onDismiss={first} />
      <Toast key="b" text="Second" onDismiss={second} />
    </>,
  );
  advance(2000);
  advance(180);
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  advance(820);
  advance(180);
  expect(second).toHaveBeenCalledOnce();
});

it('strict effect replay does not duplicate timers or reset a focused toast', () => {
  const dismiss = vi.fn();
  const { unmount } = render(
    <StrictMode>
      <Toast text="Saved" onDismiss={dismiss} />
    </StrictMode>,
  );
  expect(vi.getTimerCount()).toBe(1);
  act(() => screen.getByRole('group').focus());
  advance(10000);
  expect(dismiss).not.toHaveBeenCalled();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
