import { unstable_batchedUpdates } from 'react-dom';
import type { ConversationEvent } from '@messenger/contracts';
import { commandId } from '../lib/api';
import { frameValid } from '../lib/validation';
import { useChatProjection, useNotices } from '../state/stores';
import type { ConnectionState, Send } from './connectionCommands';
const MAX_FRAME_CHARACTERS = 32 * 1024 * 1024;

export function connectionFrames(
  state: ConnectionState,
  send: Send,
  ws: WebSocket,
  current: () => boolean,
) {
  const { pending, completed } = state;
  let textTimer: number | undefined;
  let textEvents: ConversationEvent[] = [];
  let textBytes = 0;
  const resyncRequested = new Set<string>();
  const flushText = () => {
    if (textTimer !== undefined) window.clearTimeout(textTimer);
    textTimer = undefined;
    const events = textEvents;
    textEvents = [];
    textBytes = 0;
    if (current())
      unstable_batchedUpdates(() => {
        for (const event of events)
          useChatProjection.getState().receiveEvent(event);
      });
  };
  ws.onmessage = (event: MessageEvent) => {
    if (
      !current() ||
      ws.readyState !== WebSocket.OPEN ||
      typeof event.data !== 'string' ||
      event.data.length > MAX_FRAME_CHARACTERS
    )
      return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frameValid(value)) return;
    if (value.type === 'conversation.run.text') {
      textEvents.push(value);
      textBytes += value.text.length;
      if (textEvents.length >= 128 || textBytes >= 262144) flushText();
      else if (textTimer === undefined)
        textTimer = window.setTimeout(flushText, 32);
      return;
    }
    // Keep snapshots and acknowledgements ordered after earlier text frames.
    flushText();
    if (value.type !== 'command.result') {
      useChatProjection.getState().receiveEvent(value);
      if (useChatProjection.getState().needsReconnect)
        ws.close(1013, 'Resynchronize');
      return;
    }
    if (completed.current.has(value.commandId)) return;
    const item = pending.current.get(value.commandId);
    if (!item) return;
    pending.current.delete(value.commandId);
    window.clearTimeout(item.timer);
    completed.current.add(value.commandId);
    if (completed.current.size > 500)
      completed.current.delete(completed.current.values().next().value ?? '');
    if (!value.ok) {
      item.reject(new Error(value.error.detail));
      return;
    }
    // A streaming event in another chat cannot invalidate this chat's snapshot.
    useChatProjection
      .getState()
      .applySnapshotResult(
        value.data.snapshots ??
          (value.data.snapshot ? [value.data.snapshot] : []),
        item.chatSequences,
        value.data.snapshots !== undefined,
        item.snapshotOrder,
        item.connectionEpoch,
      );
    for (const [chatId, required] of Object.entries(
      useChatProjection.getState().resyncChats,
    ))
      if (required && !resyncRequested.has(chatId)) {
        resyncRequested.add(chatId);
        void send({
          type: 'conversation.snapshot.request',
          commandId: commandId(),
          chatId,
        }).catch((error) =>
          useNotices
            .getState()
            .add(
              error instanceof Error
                ? error.message
                : 'Response refresh failed.',
            ),
        );
      }
    item.resolve(value.data);
  };

  return {
    flush: flushText,
    dispose: () => {
      if (textTimer !== undefined) window.clearTimeout(textTimer);
      textEvents = [];
    },
  };
}
