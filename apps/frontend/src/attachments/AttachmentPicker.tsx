import { useRef, useState } from 'react';
import type { Attachment } from '@messenger/contracts';
import { errorMessage, request } from '../lib/api';
import { attachmentValid, record } from '../lib/validation';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import ui from '../ui/Ui.module.css';
import styles from './Attachments.module.css';

export function AttachmentPicker({
  attachments,
  onChange,
  onBusyChange,
  disabled = false,
}: {
  attachments: Attachment[];
  onChange: (attachments: Attachment[]) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const [action, setAction] = useState<string | null>(null);
  const busy = action !== null;
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function upload(files: FileList | null) {
    if (!files || busy || disabled) return;
    setError('');
    const selection = Array.from(files);
    if (
      attachments.length + selection.length > 5 ||
      selection.some((f) => f.size > 5 * 1024 * 1024) ||
      selection.reduce(
        (size, file) => size + file.size,
        attachments.reduce((size, file) => size + file.size, 0),
      ) >
        10 * 1024 * 1024
    ) {
      setError('Attach up to 5 files, 5 MiB each and 10 MiB in total.');
      return;
    }
    setAction('upload');
    onBusyChange?.(true);
    const accepted: Attachment[] = [];
    try {
      for (const file of selection) {
        const body = new FormData();
        const name = file.name.toLowerCase();
        const inferred =
          name.endsWith('.md') || name.endsWith('.markdown')
            ? 'text/markdown'
            : name.endsWith('.txt')
              ? 'text/plain'
              : '';
        const uploadFile =
          (!file.type || file.type === 'application/octet-stream') && inferred
            ? new File([file], file.name, { type: inferred })
            : file;
        body.append('file', uploadFile);
        const { data } = await request('/api/uploads', {
          method: 'POST',
          body,
        });
        const item =
          record(data) && attachmentValid(data.attachment)
            ? data.attachment
            : data;
        if (!attachmentValid(item))
          throw new Error('Upload response was invalid. Please try again.');
        accepted.push(item);
      }
      onChange([...attachments, ...accepted]);
    } catch (cause) {
      if (accepted.length) onChange([...attachments, ...accepted]);
      setError(errorMessage(cause));
    } finally {
      setAction(null);
      onBusyChange?.(false);
      if (input.current) input.current.value = '';
    }
  }
  async function remove(item: Attachment) {
    if (busy || disabled) return;
    setError('');
    setAction(item.uploadId);
    onBusyChange?.(true);
    try {
      await request(`/api/uploads/${encodeURIComponent(item.uploadId)}`, {
        method: 'DELETE',
      });
      onChange(attachments.filter((a) => a.uploadId !== item.uploadId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
      onBusyChange?.(false);
    }
  }
  return (
    <div className={styles.picker}>
      <div className={styles.items}>
        {attachments.map((item) => (
          <span key={item.uploadId} className={styles.item}>
            {item.name}
            <Button
              busy={action === item.uploadId}
              icon="close"
              type="button"
              aria-label={`Remove ${item.name}`}
              disabled={disabled || busy}
              onClick={() => {
                void remove(item);
              }}
            />
          </span>
        ))}
      </div>
      <label className={styles.attach}>
        <span aria-busy={action === 'upload' || undefined}>
          <span
            className={`${ui.iconSlot} ${action === 'upload' ? ui.spinner : ''}`}
          >
            <Icon name={action === 'upload' ? 'spinner' : 'paperclip'} />
          </span>{' '}
          Attach files
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,text/plain,text/markdown,application/pdf,.md"
          disabled={disabled || busy}
          onChange={(event) => {
            void upload(event.target.files);
          }}
        />
      </label>
      <ErrorNotice message={error} />
    </div>
  );
}
export function AttachmentLinks({
  attachments,
}: {
  attachments: Attachment[];
}) {
  return (
    <div className={styles.items}>
      {attachments.map((item) => (
        <span key={item.uploadId} className={styles.item}>
          <Icon name="file" /> {item.name}{' '}
          <small>{Math.ceil(item.size / 1024)} KB</small>
        </span>
      ))}
    </div>
  );
}
