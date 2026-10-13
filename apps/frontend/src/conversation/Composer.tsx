import { useState } from 'react';
import type { ChatSnapshot } from '@messenger/contracts';
import { AttachmentPicker } from '../attachments/AttachmentPicker';
import { commandId, errorMessage } from '../lib/api';
import {
  emptyDraft,
  useChatProjection,
  useDrafts,
  usePreferences,
} from '../state/stores';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { useConversation } from './ConnectionProvider';
import styles from './Conversation.module.css';
export function Composer({
  snapshot,
  chatId = '',
  chatName = 'Conversation',
}: {
  snapshot?: ChatSnapshot | undefined;
  chatId?: string;
  chatName?: string | undefined;
}) {
  const id = snapshot?.chat.id ?? chatId;
  const draft = useDrafts((state) => state.drafts[id] ?? emptyDraft);
  const connection = useChatProjection((state) => state.connection);
  const transport = useChatProjection((state) => state.transport);
  const defaultBehavior = usePreferences(
    (state) => state.preferences?.busySendBehavior ?? 'queue',
  );
  const send = useConversation();
  const [behavior, setBehavior] = useState<'queue' | 'steer' | null>(null);
  const [sending, setSending] = useState(false);
  const [submittedLabel, setSubmittedLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const busy = !!snapshot?.activeRun || snapshot?.chat.status === 'running';
  const selectedBehavior = behavior ?? defaultBehavior;
  const actionLabel = busy
    ? selectedBehavior === 'queue'
      ? 'Queue message'
      : 'Steer agent'
    : 'Send message';
  async function submit() {
    if (
      !snapshot ||
      sending ||
      uploading ||
      (!draft.text.trim() && draft.attachments.length === 0)
    )
      return;
    const submitted = draft;
    setSending(true);
    setSubmittedLabel(actionLabel);
    setError('');
    try {
      await send({
        type: 'conversation.message.send',
        commandId: commandId(),
        chatId: id,
        text: submitted.text,
        uploadIds: submitted.attachments.map((a) => a.uploadId),
        behavior: selectedBehavior,
      });
      useDrafts.getState().acceptRevision(id, submitted.revision);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <div className={styles.composerWrap}>
      <ErrorNotice message={error} />
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor={`message-${id}`}>
          Message {snapshot?.chat.name ?? chatName}
        </label>
        <textarea
          id={`message-${id}`}
          value={draft.text}
          maxLength={32000}
          rows={3}
          placeholder="A question, a thought, a place to start…"
          disabled={!snapshot}
          onChange={(event) =>
            useDrafts.getState().setText(id, event.target.value)
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <AttachmentPicker
          disabled={sending || !snapshot}
          onBusyChange={setUploading}
          attachments={draft.attachments}
          onChange={(attachments) =>
            useDrafts.getState().setAttachments(id, attachments)
          }
        />
        <footer>
          {busy ? (
            <div className={styles.behavior}>
              <Select
                label="Send behavior"
                value={selectedBehavior}
                disabled={sending || uploading}
                onChange={(value) =>
                  setBehavior(value === 'steer' ? 'steer' : 'queue')
                }
                options={[
                  { value: 'queue', label: 'Queue next' },
                  { value: 'steer', label: 'Steer current run' },
                ]}
              />
            </div>
          ) : (
            <span className={styles.shortcut}>⌘ / Ctrl + Enter to send</span>
          )}
          <Button
            busy={sending}
            icon="arrowUp"
            className="primary"
            type="submit"
            disabled={
              sending ||
              uploading ||
              transport !== 'open' ||
              (busy &&
                selectedBehavior === 'steer' &&
                connection !== 'ready') ||
              !snapshot ||
              ['deleting', 'creating'].includes(snapshot.chat.status) ||
              (!draft.text.trim() && draft.attachments.length === 0)
            }
          >
            {sending ? submittedLabel : actionLabel}
          </Button>
        </footer>
      </form>
      <p className={styles.composerHint}>
        {transport !== 'open'
          ? 'Waiting for the server connection. Your draft is kept.'
          : connection !== 'ready'
            ? 'Gateway unavailable. Queued messages are saved and will wait for reconnection.'
            : 'Accepted messages keep working when you close this page.'}
      </p>
    </div>
  );
}
