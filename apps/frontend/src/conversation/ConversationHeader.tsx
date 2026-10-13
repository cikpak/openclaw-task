import { Link } from 'react-router';
import type { ChatSnapshot, ChatSummary } from '@messenger/contracts';
import { Icon } from '../ui/Icon';
import { ChatStatusDot, chatVisualStatus } from '../chats/ChatStatusDot';
import styles from './Conversation.module.css';

export function ConversationHeader({
  snapshot,
  chat,
  onSettings,
}: {
  snapshot: ChatSnapshot | undefined;
  chat: ChatSummary | undefined;
  onSettings: () => void;
}) {
  const current = snapshot?.chat ?? chat;
  const visualStatus = current ? chatVisualStatus(current, snapshot) : 'idle';
  const status = !snapshot
    ? 'Loading conversation…'
    : visualStatus === 'working'
      ? 'Agent is working'
      : visualStatus === 'failed'
        ? 'Agent request failed'
        : snapshot.chat.status === 'recovery'
          ? 'Recovery needs attention'
          : visualStatus === 'answered'
            ? 'Reply ready'
            : snapshot.chat.status === 'idle'
              ? 'Ready when you are'
              : snapshot.chat.status;
  return (
    <>
      <header className={styles.header}>
        <Link
          className={styles.mobileBack}
          to="/"
          aria-label="Back to conversations"
        >
          <Icon name="arrowLeft" />
        </Link>
        <div className={styles.heading}>
          <h1>{current?.name ?? 'Conversation'}</h1>
          <p>
            {current ? (
              <ChatStatusDot chat={current} snapshot={snapshot} />
            ) : null}
            {status} <span aria-hidden="true">·</span> {current?.settings.model}
          </p>
        </div>
        <button
          type="button"
          onClick={onSettings}
          aria-label="Agent settings"
          disabled={!snapshot}
        >
          Settings
        </button>
      </header>
      {snapshot?.pendingSettings ? (
        <div className={styles.pendingSettings} role="status">
          Settings change {snapshot.pendingSettings.status}:{' '}
          {snapshot.pendingSettings.settings.model}.{' '}
          {snapshot.pendingSettings.policy === 'when-idle'
            ? 'Applies after all active and queued work finishes.'
            : 'Cancelling work before applying.'}
        </div>
      ) : null}
    </>
  );
}
