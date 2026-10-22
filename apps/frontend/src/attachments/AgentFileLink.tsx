import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { commandId, errorMessage } from '../lib/api';
import { dispatchApplication } from '../lib/manager';
import { Icon } from '../ui/Icon';
import styles from './Attachments.module.css';

export const AgentFileChat = createContext<string | null>(null);
type FileCard = { name: string; sizeBytes: number };

/** Local model links are file references, not browser routes or trusted URLs. */
export function isAgentFileReference(href: string): boolean {
  return /^file:[A-Za-z0-9_-]{1,128}$/u.test(href);
}
export function AgentFileLink({
  href,
  children,
  card,
}: {
  href: string;
  children: ReactNode;
  card?: FileCard;
}) {
  const chatId = useContext(AgentFileChat);
  if (!chatId) return <span>{children}</span>;
  return (
    <FileDownload
      key={`${chatId}:${href}`}
      chatId={chatId}
      href={href}
      card={card}
    >
      {children}
    </FileDownload>
  );
}
function FileDownload({
  chatId,
  href,
  children,
  card,
}: {
  chatId: string;
  href: string;
  children: ReactNode;
  card?: FileCard | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [chatId, href]);
  async function download() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    try {
      const result = await dispatchApplication({
        type: 'files.resolve',
        commandId: commandId(),
        chatId,
        fileId: href.slice(5),
      });
      if (abort.signal.aborted) return;
      if (
        !result.file ||
        !result.download ||
        !/^\/downloads\/[a-f0-9]{64}$/u.test(result.download.url)
      )
        throw new Error('This file could not be downloaded.');
      const artifact = result.file;
      const anchor = document.createElement('a');
      anchor.href = result.download.url;
      anchor.download = artifact.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      if (!abort.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (controller.current === abort) controller.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <span className={card ? styles.fileCardWrapper : undefined}>
      <button
        type="button"
        className={card ? styles.fileCard : styles.fileDownload}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={
          card
            ? `Download ${card.name} (${Math.ceil(card.sizeBytes / 1024)} KB)`
            : undefined
        }
        title={card?.name}
        onClick={() => void download()}
      >
        {card ? (
          <>
            <span className={styles.fileCardName} title={card.name}>
              {children}
            </span>
            <small className={styles.fileCardSize}>
              {Math.ceil(card.sizeBytes / 1024)} KB
            </small>
          </>
        ) : null}
        <span
          className={
            [
              card ? styles.fileCardIcon : '',
              busy ? styles.fileDownloadSpinner : '',
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          aria-hidden="true"
        >
          <Icon name={busy ? 'spinner' : 'download'} />
        </span>
        {card ? null : children}
      </button>
      {error ? (
        <span className={styles.fileDownloadError} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
