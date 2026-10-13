import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useMatch } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useChatProjection } from '../state/stores';

export function PageTitle({ children }: { children?: ReactNode }) {
  const { session, loading, error } = useAuth();
  const { pathname } = useLocation();
  const match = useMatch('/chat/:chatId');
  const chatId = match?.params.chatId;
  // Subscribe only to identity metadata, never streamed text or message content.
  const chatName = useChatProjection((state) =>
    chatId && !state.deletedChats[chatId]
      ? (state.chats[chatId]?.name ?? state.snapshots[chatId]?.chat.name)
      : undefined,
  );
  const page = loading
    ? 'Opening workspace'
    : error
      ? 'Workspace unavailable'
      : !session?.authenticated
        ? 'Sign in'
        : match
          ? chatName || 'Conversation'
          : pathname === '/settings'
            ? 'Settings'
            : 'Conversations';
  useEffect(() => {
    document.title = `${page} — OpenClaw`;
  }, [page]);
  return children ?? null;
}
