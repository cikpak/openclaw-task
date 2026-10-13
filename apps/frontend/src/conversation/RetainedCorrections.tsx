import type { PendingMessage } from '@messenger/contracts';
import { useDrafts } from '../state/stores';
import { ErrorNotice } from '../ui/Modal';
import styles from './Conversation.module.css';
export function RetainedCorrections({
  chatId,
  pending,
}: {
  chatId: string;
  pending: PendingMessage[];
}) {
  const corrections = useDrafts((state) => state.corrections);
  return (
    <>
      {Object.values(corrections)
        .filter(
          (correction) =>
            correction.chatId === chatId &&
            !pending.some(
              (message) =>
                message.id === correction.messageId &&
                message.state === 'pending',
            ),
        )
        .map((correction) => (
          <article
            className={styles.queued}
            key={correction.messageId}
            aria-label="Saved queue correction"
          >
            <span className={styles.queueLabel}>Your correction is kept</span>
            <p>
              The original message has left the editable queue. Review the
              conversation before sending this correction separately.
            </p>
            <label>
              Retained correction
              <textarea
                rows={3}
                maxLength={32000}
                value={correction.text}
                onChange={(event) =>
                  useDrafts
                    .getState()
                    .updateCorrection(correction.messageId, event.target.value)
                }
              />
            </label>
            <ErrorNotice message={correction.error} />
            <div className={styles.queueActions}>
              <button
                type="button"
                onClick={() => {
                  const existing =
                    useDrafts.getState().drafts[chatId]?.text ?? '';
                  useDrafts
                    .getState()
                    .setText(
                      chatId,
                      existing
                        ? `${existing}\n\n${correction.text}`
                        : correction.text,
                    );
                  useDrafts.getState().clearCorrection(correction.messageId);
                }}
              >
                Add correction to draft
              </button>
              <button
                type="button"
                onClick={() =>
                  useDrafts.getState().clearCorrection(correction.messageId)
                }
              >
                Discard correction
              </button>
            </div>
          </article>
        ))}
    </>
  );
}
