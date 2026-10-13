import type { ChatSnapshot, ChatSummary } from '@messenger/contracts';
import { useChatProjection } from '../state/stores';
import styles from '../ui/Ui.module.css';

export function chatVisualStatus(
  chat: ChatSummary,
  snapshot?: ChatSnapshot,
): 'working' | 'answered' | 'failed' | 'attention' | 'idle' {
  if (chat.status === 'creating' || chat.status === 'deleting') return 'idle';
  if (chat.status === 'recovery') return 'attention';
  if (chat.status === 'running' || snapshot?.activeRun) return 'working';
  if (snapshot?.settledRun?.state === 'error') return 'failed';
  if (snapshot?.settledRun?.state === 'aborted') return 'idle';
  const reply = snapshot?.messages.findLast(
    (message) => message.role === 'assistant',
  );
  if (reply?.requestFailed) return 'failed';
  return snapshot?.settledRun?.state === 'final' ||
    (reply && (reply.text.trim().length > 0 || !!reply.artifacts?.length))
    ? 'answered'
    : 'idle';
}

const labels = {
  working: 'Agent is working',
  answered: 'Agent replied',
  attention: 'Needs attention',
  failed: 'Agent request failed',
  idle: 'Ready when you are',
};

export function ChatStatusDot({
  chat,
  snapshot,
}: {
  chat: ChatSummary;
  snapshot?: ChatSnapshot | undefined;
}) {
  // Subscribe to the derived status, not every streaming text update.
  const state = useChatProjection((projection) =>
    chatVisualStatus(chat, snapshot ?? projection.snapshots[chat.id]),
  );
  return (
    <span
      className={styles.chatStatusDot}
      data-chat-state={state}
      role="img"
      aria-label={labels[state]}
      title={labels[state]}
    />
  );
}
