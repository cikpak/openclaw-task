import { useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import type { ChatSnapshot, ToolActivity } from '@messenger/contracts';
const noTools: ToolActivity[] = [];

/** Manual prepend anchoring avoids relying on browser-specific scroll anchoring. */
export function useHistoryViewport(
  snapshot: ChatSnapshot | undefined,
  tools: ToolActivity[] = noTools,
) {
  const history = useRef<HTMLDivElement>(null);
  const followingTail = useRef(true);
  const olderAnchor = useRef<{ height: number; top: number } | null>(null);
  const [newBelow, setNewBelow] = useState(false);
  useLayoutEffect(() => {
    const viewport = history.current;
    if (!viewport) return;
    if (olderAnchor.current) {
      viewport.scrollTop =
        olderAnchor.current.top +
        viewport.scrollHeight -
        olderAnchor.current.height;
      olderAnchor.current = null;
    } else if (followingTail.current)
      viewport.scrollTop = viewport.scrollHeight;
    else if (snapshot) setNewBelow(true);
  }, [
    snapshot?.messages,
    snapshot?.pending,
    tools,
    snapshot?.activeRun?.text,
    snapshot?.activeRun?.id,
    snapshot?.settledRun?.text,
    snapshot?.settledRun?.id,
  ]);

  function captureOlderAnchor() {
    followingTail.current = false;
    return () => {
      // Capture immediately before applying the page, not before the network read.
      // Streaming growth and reader movement while waiting must not count as a prepend.
      olderAnchor.current = history.current
        ? {
            height: history.current.scrollHeight,
            top: history.current.scrollTop,
          }
        : null;
    };
  }
  function onScroll(event: UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget;
    followingTail.current =
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 80;
    if (followingTail.current) setNewBelow(false);
  }
  function jumpToLatest() {
    followingTail.current = true;
    if (history.current)
      history.current.scrollTop = history.current.scrollHeight;
    setNewBelow(false);
  }
  return { history, newBelow, onScroll, captureOlderAnchor, jumpToLatest };
}
