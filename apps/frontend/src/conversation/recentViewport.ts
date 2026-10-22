import type { HistoryViewport } from '@messenger/contracts';
export function recentViewport(element?: HTMLElement | null): HistoryViewport {
  const content = element?.querySelector<HTMLElement>('[data-message-content]');
  const style = getComputedStyle(
    content ?? element ?? document.documentElement,
  );
  const fontSize = Number.parseFloat(style.fontSize) || 16;
  const inner = element?.firstElementChild as HTMLElement | null | undefined;
  const availableWidth =
    inner?.clientWidth || element?.clientWidth || window.innerWidth;
  return {
    // Message bubbles use 85% of the measured transcript column.
    width: Math.max(1, availableWidth * 0.85),
    height: Math.max(1, element?.clientHeight || window.innerHeight),
    fontSize,
    lineHeight: Number.parseFloat(style.lineHeight) || fontSize * 1.7,
  };
}
