import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react';
import type { ReactNode } from 'react';
import type { ManagerCommand } from '@messenger/contracts';
import { useAuth } from '../auth/AuthProvider';
import { useChatProjection } from '../state/stores';
import type { Pending, Send } from './connectionCommands';
import { startConnection } from './connectionTransport';
const ConnectionContext = createContext<Send | null>(null);
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const { refresh } = useAuth();
  const socket = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const completed = useRef(new Set<string>());
  const snapshotOrder = useRef(0);
  const send: Send = useCallback(
    (command: ManagerCommand) =>
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
        const timer = window.setTimeout(
          () => {
            pending.current.delete(command.commandId);
            reject(
              new Error(
                command.type === 'conversation.message.send' ||
                  command.type === 'chat.create'
                  ? 'Delivery is unconfirmed. Your draft has been kept. Check the conversation before sending it again.'
                  : 'This operation is taking longer than expected. Refresh before trying it again.',
              ),
            );
          },
          command.type === 'conversation.message.send' ||
            command.type === 'chat.create'
            ? 15000
            : 720000,
        );
        pending.current.set(command.commandId, {
          resolve,
          reject,
          timer,
          chatSequences: { ...useChatProjection.getState().chatSequences },
          chatId: 'chatId' in command ? command.chatId : undefined,
          type: command.type,
          snapshotOrder:
            command.type === 'conversation.snapshot.request' ||
            command.type === 'conversation.recent.request'
              ? ++snapshotOrder.current
              : 0,
          connectionEpoch: useChatProjection.getState().connectionEpoch,
        });
        socket.current.send(JSON.stringify(command));
      }),
    [],
  );
  useEffect(() => {
    const stop = startConnection(
      { socket, pending, completed, snapshotOrder },
      send,
      refresh,
    );
    return stop;
  }, [refresh, send]);
  return <ConnectionContext value={send}>{children}</ConnectionContext>;
}
export function useConversation() {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error('ConnectionProvider is missing.');
  return context;
}
