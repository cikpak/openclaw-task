import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage, request } from '../lib/api';
import { artifactValid, record } from '../lib/validation';
import { Icon } from '../ui/Icon';
import styles from './Attachments.module.css';

export const AgentFileChat = createContext<string | null>(null);

/** Local model links are file references, not browser routes or trusted URLs. */
export function isAgentFileReference(href: string): boolean {
  return (
    href.startsWith('sandbox:') ||
    (!!href &&
      !href.startsWith('#') &&
      !/^[a-z][a-z\d+.-]*:/iu.test(href) &&
      !href.startsWith('//'))
  );
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
      const { data } = await request(
        `/api/chats/${encodeURIComponent(chatId)}/artifacts/resolve?path=${encodeURIComponent(href)}`,
        { signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      if (!record(data) || !artifactValid(data.artifact))
        throw new Error('This file could not be downloaded.');
      const artifact = data.artifact;
      const response = await fetch(
        `/api/chats/${encodeURIComponent(chatId)}/artifacts/${encodeURIComponent(artifact.id)}`,
        { credentials: 'same-origin', signal: abort.signal },
      );
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'This file is no longer available.'
            : 'This file could not be downloaded. Please try again.',
        );
      const blob = await response.blob();
      if (abort.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = artifact.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
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
