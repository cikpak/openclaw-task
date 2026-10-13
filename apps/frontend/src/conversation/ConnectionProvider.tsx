import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import type { ReactNode } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
import type {
  ConversationCommand,
  ConversationEvent,
  ConversationResult,
} from '@messenger/contracts';
import { useAuth } from '../auth/AuthProvider';
import { commandId, request } from '../lib/api';
import { chatValid, frameValid, record } from '../lib/validation';
import { useChatProjection, useNotices } from '../state/stores';
// Per-chat projected queues, tools and previews may expand sixfold in JSON.
const MAX_FRAME_CHARACTERS = 32 * 1024 * 1024;

type Send = (
  command: ConversationCommand,
) => Promise<Extract<ConversationResult, { ok: true }>['data']>;
const ConnectionContext = createContext<Send | null>(null);
interface Pending {
  resolve(data: Extract<ConversationResult, { ok: true }>['data']): void;
  reject(error: Error): void;
  timer: number;
  chatSequences: Record<string, number>;
  chatId: string | undefined;
  type: ConversationCommand['type'];
  snapshotOrder: number;
  connectionEpoch: number;
}
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const { refresh } = useAuth();
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const completed = useRef(new Set<string>());
  const snapshotOrder = useRef(0);
  const send: Send = useCallback(
    (command: ConversationCommand) =>
      new Promise((resolve, reject) => {
        if (
          !socket.current ||
          socket.current.readyState !== WebSocket.OPEN ||
          socket.current.bufferedAmount > 262144
        ) {
          reject(
            new Error(
              'The connection is unavailable. Your draft has been kept.',
            ),
          );
          return;
        }
        const timer = window.setTimeout(() => {
          pending.current.delete(command.commandId);
          reject(
            new Error(
              'Delivery is unconfirmed. Your draft has been kept. Check the conversation before sending it again.',
            ),
          );
        }, 15000);
        pending.current.set(command.commandId, {
          resolve,
          reject,
          timer,
          chatSequences: { ...useChatProjection.getState().chatSequences },
          chatId: 'chatId' in command ? command.chatId : undefined,
          type: command.type,
          snapshotOrder:
            command.type === 'conversation.snapshot.request'
              ? ++snapshotOrder.current
              : 0,
          connectionEpoch: useChatProjection.getState().connectionEpoch,
        });
        socket.current.send(JSON.stringify(command));
      }),
    [],
  );
  useEffect(() => {
    let disposed = false;
    let retry: number | undefined;
    let epoch = 0;
    let attempts = 0;
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
      if (!disposed)
        unstable_batchedUpdates(() => {
          for (const event of events)
            useChatProjection.getState().receiveEvent(event);
        });
    };
    const failPending = () => {
      for (const item of pending.current.values()) {
        window.clearTimeout(item.timer);
        item.reject(
          new Error(
            'Connection interrupted. Delivery is unconfirmed; your draft is still available. Check the conversation before retrying.',
          ),
        );
      }
      pending.current.clear();
    };
    function connect() {
      if (disposed) return;
      resyncRequested.clear();
      const connectionEpoch = ++epoch;
      useChatProjection.getState().beginConnection();
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/conversation`,
      );
      socket.current = ws;
      ws.onopen = () => {
        if (connectionEpoch !== epoch || disposed) return;
        attempts = 0;
        useChatProjection.getState().markTransportOpen();
        void (async () => {
          const sequences = { ...useChatProjection.getState().chatSequences };
          const requestEpoch = useChatProjection.getState().connectionEpoch;
          const { data } = await request('/api/chats');
          if (
            disposed ||
            connectionEpoch !== epoch ||
            ws.readyState !== WebSocket.OPEN
          )
            return;
          if (
            !record(data) ||
            !Array.isArray(data.chats) ||
            data.chats.length > 10 ||
            !data.chats.every(chatValid)
          )
            throw new Error('Conversation catalog could not be refreshed.');
          useChatProjection
            .getState()
            .applyCatalogResult(data.chats, sequences, requestEpoch);
          // Sequential per-chat responses keep reconnect traffic bounded by one snapshot.
          for (const chat of Object.values(
            useChatProjection.getState().chats,
          )) {
            if (
              disposed ||
              connectionEpoch !== epoch ||
              ws.readyState !== WebSocket.OPEN
            )
              return;
            try {
              await send({
                type: 'conversation.snapshot.request',
                commandId: commandId(),
                chatId: chat.id,
              });
            } catch (error) {
              if (disposed || connectionEpoch !== epoch) return;
              useNotices
                .getState()
                .add(
                  `${chat.name}: ${error instanceof Error ? error.message : 'Conversation refresh failed.'}`,
                );
            }
          }
        })().catch((error) =>
          useNotices
            .getState()
            .add(
              error instanceof Error
                ? error.message
                : 'Conversation refresh failed.',
            ),
        );
      };
      ws.onmessage = (event) => {
        if (
          connectionEpoch !== epoch ||
          disposed ||
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
          completed.current.delete(
            completed.current.values().next().value ?? '',
          );
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
      ws.onerror = () => useChatProjection.getState().markUnavailable();
      ws.onclose = (event) => {
        if (connectionEpoch !== epoch || disposed) return;
        socket.current = null;
        flushText();
        useChatProjection.getState().markTransportClosed();
        useChatProjection.getState().markUnavailable();
        failPending();
        if (event.code === 1008) {
          void refresh();
          return;
        }
        retry = window.setTimeout(
          connect,
          Math.min(1000 * 2 ** attempts++, 15000),
        );
      };
    }
    connect();
    return () => {
      disposed = true;
      epoch++;
      if (retry !== undefined) window.clearTimeout(retry);
      if (textTimer !== undefined) window.clearTimeout(textTimer);
      textEvents = [];
      socket.current?.close();
      socket.current = null;
      failPending();
    };
  }, [refresh, send]);
  return <ConnectionContext value={send}>{children}</ConnectionContext>;
}
export function useConversation() {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error('ConnectionProvider is missing.');
  return context;
}
