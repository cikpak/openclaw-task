import type { Page } from '@playwright/test';
export type StreamEvidence = {
  frames: Array<{ size: number; visibleSize: number; at: number }>;
  paints: Array<{
    size: number;
    at: number;
    delay: number;
    matchesFrame: boolean;
    inView: boolean;
    sameNode: boolean;
  }>;
  terminalAt: number | null;
};

export async function observeStream(page: Page) {
  await page.addInitScript(() => {
    const state: StreamEvidence = { frames: [], paints: [], terminalAt: null };
    Object.assign(window, { polishStream: state });
    let projectedRunId = '';
    let projectedText = '';
    const received = new Set<string>();
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      private applicationUi = false;
      override send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          const command = JSON.parse(data) as { type?: string };
          if (
            command.type === 'conversation.message.send' ||
            command.type === 'conversation.recent.request'
          )
            this.applicationUi = true;
        }
        super.send(data);
      }
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event: MessageEvent<string>) => {
          if (!this.applicationUi) return;
          const frame = JSON.parse(event.data) as {
            type: string;
            text?: string;
            runId?: string;
            replace?: boolean;
            runSequence?: number;
            snapshot?: { activeRun?: unknown; settledRun?: unknown };
          };
          if (
            frame.type === 'conversation.run.text' &&
            frame.text &&
            frame.runId
          ) {
            // Public replay can repeat native deltas with a new manager envelope.
            // Count each native run sequence once, as the browser projection does.
            const identity = `${frame.runId}:${frame.runSequence}`;
            if (received.has(identity)) return;
            received.add(identity);
            if (frame.runId !== projectedRunId || frame.replace)
              projectedText = '';
            projectedRunId = frame.runId;
            projectedText = projectedText + frame.text;
            state.frames.push({
              size: projectedText.length,
              visibleSize: projectedText.trimEnd().length,
              at: performance.now(),
            });
          }
          if (
            state.frames.length &&
            frame.type === 'conversation.snapshot' &&
            !frame.snapshot?.activeRun
          )
            state.terminalAt ??= performance.now();
        });
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        const content = document.querySelector(
          '[data-message-state="active"] > [data-message-content]',
        );
        const text = content?.textContent ?? '';
        if (!text || text === 'Thinking…' || !state.frames.length) return;
        const size = Number(content?.getAttribute('data-message-source-size'));
        if (!size) return;
        if (state.paints.at(-1)?.size === size) return;
        const frame = state.frames.findLast(
          (received) =>
            received.size === size && received.visibleSize === text.length,
        );
        const previousNode = (
          window as unknown as { polishReplyNode?: Element }
        ).polishReplyNode;
        if (!previousNode) Object.assign(window, { polishReplyNode: content });
        requestAnimationFrame(() =>
          state.paints.push({
            size,
            at: performance.now(),
            delay: frame
              ? performance.now() - frame.at
              : Number.POSITIVE_INFINITY,
            matchesFrame: !!frame,
            sameNode: !previousNode || previousNode === content,
            inView:
              !!content &&
              content.getBoundingClientRect().top >= 0 &&
              content.getBoundingClientRect().bottom <= innerHeight,
          }),
        );
      }).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  });
}
