import styles from './Conversation.module.css';

export function ThinkingIndicator({
  usingTools = false,
}: {
  usingTools?: boolean;
}) {
  return (
    <p
      className={styles.thinking}
      role="status"
      aria-label={usingTools ? 'Agent is using tools' : 'Agent is thinking'}
    >
      <span aria-hidden="true">
        {usingTools ? 'Using tools…' : 'Thinking…'}
      </span>
    </p>
  );
}
