import { useLayoutEffect, type RefObject } from 'react';

/** Keep the composer in the same available width as the scrolling transcript. */
export function useHistoryGutter(
  history: RefObject<HTMLDivElement | null>,
  body: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const viewport = history.current;
    const container = body.current;
    if (!viewport || !container) return;
    let active = true;
    let gutter = -1;
    const measure = () => {
      if (!active) return;
      const next = Math.max(0, viewport.offsetWidth - viewport.clientWidth);
      if (next === gutter) return;
      gutter = next;
      container.style.setProperty('--chat-scrollbar-gutter', `${next}px`);
    };
    measure();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(viewport);
    else window.addEventListener('resize', measure);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      container.style.removeProperty('--chat-scrollbar-gutter');
    };
  }, [history, body]);
}
