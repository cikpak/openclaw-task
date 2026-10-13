import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { ArtifactCatalog } from '../attachments/Artifacts';
import { commandId, errorMessage } from '../lib/api';
import { ChatSettingsPanel } from '../settings/ChatSettingsPanel';
import { useChatProjection } from '../state/stores';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Composer } from './Composer';
import { ConversationMessages } from './MessageBubble';
import { ConversationHeader } from './ConversationHeader';
import { useHistoryViewport } from './useHistoryViewport';
import { useHistoryGutter } from './useHistoryGutter';
import { useConversation } from './ConnectionProvider';
import { QueuedCard } from './QueuedCard';
import { RetainedCorrections } from './RetainedCorrections';
import styles from './Conversation.module.css';
const emptyTools: never[] = [];
export function ConversationPage() {
  const { chatId = '' } = useParams();
  return <ConversationView key={chatId} chatId={chatId} />;
}
function ConversationView({ chatId }: { chatId: string }) {
  const snapshot = useChatProjection((state) => state.snapshots[chatId]);
  const chat = useChatProjection((state) => state.chats[chatId]);
  const tools = useChatProjection((state) => state.tools[chatId] ?? emptyTools);
  const send = useConversation();
  const connection = useChatProjection((state) => state.connection);
  const deleted = useChatProjection((state) => state.deletedChats[chatId]);
  const needsResync = useChatProjection((state) => state.resyncChats[chatId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await send({
        type: 'conversation.snapshot.request',
        commandId: commandId(),
        chatId,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }
  const { history, newBelow, onScroll, captureOlderAnchor, jumpToLatest } =
    useHistoryViewport(snapshot, tools);
  const chatBody = useRef<HTMLDivElement>(null);
  useHistoryGutter(history, chatBody);
  useEffect(() => {
    if (connection !== 'ready') return;
    let active = true;
    void send({
      type: 'conversation.snapshot.request',
      commandId: commandId(),
      chatId,
    }).catch((cause) => {
      if (active) setError(errorMessage(cause));
    });
    return () => {
      active = false;
    };
  }, [chatId, send, connection]);
  const lastMessage = snapshot?.messages.at(-1)?.id;
  const unread = snapshot?.chat.unread ?? false;
  useEffect(() => {
    const markRead = () => {
      if (
        connection === 'ready' &&
        unread &&
        document.visibilityState === 'visible'
      )
        void send({
          type: 'conversation.message.read',
          commandId: commandId(),
          chatId,
        }).catch((cause) => setError(errorMessage(cause)));
    };
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [chatId, connection, lastMessage, send, unread]);
  async function older() {
    if (!snapshot || loadingHistory) return;
    const restoreAnchor = captureOlderAnchor();
    setLoadingHistory(true);
    setError('');
    try {
      const data = await send({
        type: 'conversation.history.request',
        commandId: commandId(),
        chatId,
        cursor: snapshot.historyCursor ?? undefined,
      });
      if (data.messages) {
        restoreAnchor();
        useChatProjection
          .getState()
          .prependHistory(
            chatId,
            data.messages,
            data.historyCursor ?? null,
            data.hasOlderHistory ?? false,
          );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingHistory(false);
    }
  }
  async function abort() {
    if (aborting) return;
    setAborting(true);
    setError('');
    try {
      await send({
        type: 'conversation.run.abort',
        commandId: commandId(),
        chatId,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAborting(false);
    }
  }
  if (deleted) return <Navigate to="/" replace />;
  return (
    <main className={styles.conversation}>
      <ConversationHeader
        snapshot={snapshot}
        chat={chat}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className={styles.workspace}>
        <ArtifactCatalog chatId={chatId} />
        <div className={styles.chatBody} ref={chatBody}>
          <div className={styles.transcript}>
            <div ref={history} className={styles.history} onScroll={onScroll}>
              <div className={styles.historyInner}>
                {snapshot?.hasOlderHistory ? (
                  <Button
                    busy={loadingHistory}
                    icon="refresh"
                    type="button"
                    className={styles.older}
                    disabled={loadingHistory}
                    onClick={() => {
                      void older();
                    }}
                  >
                    Load earlier messages
                  </Button>
                ) : null}
                <ErrorNotice message={error} />
                {!snapshot ? (
                  <div className={styles.loading}>
                    <p role="status">Loading conversation…</p>
                    <div className={styles.skeleton} aria-hidden="true" />
                    <div className={styles.skeleton} aria-hidden="true" />
                    <Button
                      busy={refreshing}
                      icon="refresh"
                      onClick={() => {
                        void refresh();
                      }}
                    >
                      Refresh conversation
                    </Button>
                  </div>
                ) : null}
                {needsResync ? (
                  <div className={styles.pendingSettings} role="status">
                    <p>
                      Refreshing this response after a connection gap. If it
                      remains incomplete, refresh the conversation.
                    </p>
                    <Button
                      busy={refreshing}
                      icon="refresh"
                      type="button"
                      onClick={() => {
                        void refresh();
                      }}
                    >
                      Refresh response
                    </Button>
                  </div>
                ) : null}
                {snapshot ? (
                  <ConversationMessages
                    snapshot={snapshot}
                    tools={tools}
                    aborting={aborting}
                    onAbort={() => {
                      void abort();
                    }}
                  >
                    {snapshot.hiddenPendingCount ? (
                      <div className={styles.pendingSettings} role="status">
                        {snapshot.hiddenPendingCount} more messages remain
                        stored on the server. Resolve the visible recovery items
                        or wait for work to finish to reveal the next messages.
                      </div>
                    ) : null}
                    {snapshot.pending
                      .filter((message) => message.state !== 'cancelled')
                      .sort((a, b) => a.position - b.position)
                      .map((message) => (
                        <QueuedCard
                          key={message.id}
                          message={message}
                          canSteer={!!snapshot.activeRun}
                        />
                      ))}
                    <RetainedCorrections
                      chatId={chatId}
                      pending={snapshot.pending}
                    />
                  </ConversationMessages>
                ) : null}
              </div>
            </div>
            {newBelow ? (
              <Button
                icon="chevronDown"
                className={styles.jumpLatest}
                onClick={jumpToLatest}
              >
                Jump to latest
              </Button>
            ) : null}
          </div>
          <div className={styles.composerViewport}>
            <Composer
              key={`composer-${chatId}`}
              snapshot={snapshot}
              chatId={chatId}
              chatName={chat?.name}
            />
          </div>
        </div>
      </div>
      {settingsOpen && snapshot ? (
        <ChatSettingsPanel
          key={`settings-${chatId}`}
          snapshot={snapshot}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
}
