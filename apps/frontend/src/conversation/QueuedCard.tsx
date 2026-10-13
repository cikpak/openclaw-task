import { useState } from 'react';
import type { PendingMessage } from '@messenger/contracts';
import { AttachmentLinks } from '../attachments/AttachmentPicker';
import { commandId, errorMessage } from '../lib/api';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useChatProjection, useDrafts } from '../state/stores';
import { useConversation } from './ConnectionProvider';
import styles from './Conversation.module.css';
export function QueuedCard({
  message,
  canSteer,
}: {
  message: PendingMessage;
  canSteer: boolean;
}) {
  const send = useConversation();
  const correction = useDrafts((state) => state.corrections[message.id]);
  const [editing, setEditing] = useState(!!correction);
  const text = correction?.text ?? message.text;
  const isEditable = editing && message.state === 'pending';
  const submitted = message.state === 'submitted';
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const busy = pendingAction !== null;
  const [error, setError] = useState('');
  async function action(
    type: 'edit' | 'cancel' | 'steer' | 'retry' | 'discard',
  ) {
    if (busy) return;
    setPendingAction(type);
    setError('');
    const base = {
      commandId: commandId(),
      chatId: message.chatId,
      messageId: message.id,
      revision:
        type === 'edit'
          ? (correction?.revision ?? message.revision)
          : message.revision,
    };
    try {
      if (type === 'edit')
        await send({
          ...base,
          type: 'conversation.message.editQueued',
          text,
          uploadIds: message.attachments.map((a) => a.uploadId),
        });
      else if (type === 'retry' || type === 'discard')
        await send({
          ...base,
          type: 'conversation.message.resolveUnknown',
          action: type,
        });
      else
        await send({
          ...base,
          type:
            type === 'cancel'
              ? 'conversation.message.cancelQueued'
              : 'conversation.message.steerQueued',
        });
      if (type === 'edit') {
        const confirmed = useChatProjection
          .getState()
          .snapshots[message.chatId]?.pending.find(
            (item) => item.id === message.id,
          )?.revision;
        useDrafts
          .getState()
          .acceptCorrection(
            message.id,
            correction?.draftRevision ?? 0,
            confirmed && confirmed > base.revision
              ? confirmed
              : base.revision + 1,
          );
        setEditing(!!useDrafts.getState().corrections[message.id]);
      } else setEditing(false);
    } catch (cause) {
      setError(errorMessage(cause));
      if (type === 'edit')
        useDrafts.getState().failCorrection(message.id, errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  }
  return (
    <article
      className={
        submitted ? `${styles.message} ${styles.userMessage}` : styles.queued
      }
      aria-label={`Queued message ${message.position}`}
      data-message-id={message.id}
      data-message-role="user"
      data-message-state={message.state}
    >
      <header>
        {submitted ? (
          <>
            You
            <time dateTime={new Date(message.createdAt).toISOString()}>
              {new Date(message.createdAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          </>
        ) : (
          <span className={styles.queueLabel}>
            {message.state === 'pending'
              ? `Queued · ${message.position}`
              : message.state === 'unknown'
                ? 'Delivery unconfirmed'
                : message.state === 'submitting'
                  ? 'Submitting…'
                  : 'Cancelled'}
          </span>
        )}
      </header>
      {isEditable ? (
        <label>
          Correction
          <textarea
            value={text}
            rows={3}
            maxLength={32000}
            onChange={(event) =>
              useDrafts
                .getState()
                .updateCorrection(message.id, event.target.value)
            }
          />
        </label>
      ) : (
        <p>{message.text || 'Attachments'}</p>
      )}
      <AttachmentLinks attachments={message.attachments} />
      {message.state === 'unknown' ? (
        <p className={styles.recoveryHint}>
          The connection ended before delivery was confirmed. Check the
          conversation before choosing to retry. Your original content is
          retained.
        </p>
      ) : null}
      <ErrorNotice message={error} />
      {error && correction && message.state === 'pending' ? (
        <div>
          <p className={styles.recoveryHint}>
            Latest queued content: {message.text}
          </p>
          <button
            type="button"
            onClick={() => {
              useDrafts
                .getState()
                .rebaseCorrection(message.id, message.revision);
              setError('');
            }}
          >
            Use latest revision, keep my correction
          </button>
        </div>
      ) : null}
      {!submitted ? (
        <div className={styles.queueActions}>
          {isEditable ? (
            <>
              <Button
                busy={pendingAction === 'edit'}
                icon="check"
                type="button"
                disabled={busy || (!text.trim() && !message.attachments.length)}
                onClick={() => {
                  void action('edit');
                }}
              >
                Save correction
              </Button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  useDrafts.getState().clearCorrection(message.id);
                }}
              >
                Keep original
              </button>
            </>
          ) : message.state === 'pending' ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  useDrafts
                    .getState()
                    .beginCorrection(
                      message.chatId,
                      message.id,
                      message.text,
                      message.revision,
                    );
                  setEditing(true);
                }}
              >
                Edit
              </button>
              <Button
                busy={pendingAction === 'cancel'}
                icon="close"
                type="button"
                disabled={busy}
                onClick={() => {
                  void action('cancel');
                }}
              >
                Cancel
              </Button>
              <Button
                busy={pendingAction === 'steer'}
                icon="arrowRight"
                type="button"
                disabled={busy || !canSteer}
                onClick={() => {
                  void action('steer');
                }}
              >
                Steer instead
              </Button>
            </>
          ) : message.state === 'unknown' ? (
            <>
              <Button
                busy={pendingAction === 'retry'}
                icon="refresh"
                type="button"
                disabled={busy}
                onClick={() => {
                  void action('retry');
                }}
              >
                Retry with receipt check
              </Button>
              <Button
                busy={pendingAction === 'discard'}
                icon="close"
                type="button"
                disabled={busy}
                onClick={() => {
                  void action('discard');
                }}
              >
                Discard
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {isEditable ? (
        <p className={styles.recoveryHint}>
          Your correction keeps this message’s queue position.
        </p>
      ) : null}
    </article>
  );
}
