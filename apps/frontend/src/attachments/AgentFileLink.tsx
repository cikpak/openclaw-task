import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { commandId, errorMessage } from '../lib/api';
import { dispatchApplication } from '../lib/manager';
import { Icon } from '../ui/Icon';
import styles from './Attachments.module.css';

export const AgentFileChat = createContext<string | null>(null);

/** Local model links are file references, not browser routes or trusted URLs. */
export function isAgentFileReference(href: string): boolean {
  return /^file:[A-Za-z0-9_-]{1,128}$/u.test(href);
}
export function AgentFileLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const chatId = useContext(AgentFileChat);
  if (!chatId) return <span>{children}</span>;
  return (
    <FileDownload key={`${chatId}:${href}`} chatId={chatId} href={href}>
      {children}
    </FileDownload>
  );
}
function FileDownload({
  chatId,
  href,
  children,
}: {
  chatId: string;
  href: string;
  children: ReactNode;
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
    <span>
      <button
        type="button"
        className={styles.fileDownload}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void download()}
      >
        <span
          className={busy ? styles.fileDownloadSpinner : undefined}
          aria-hidden="true"
        >
          <Icon name={busy ? 'spinner' : 'download'} />
        </span>
        {children}
      </button>
      {error ? (
        <span className={styles.fileDownloadError} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
