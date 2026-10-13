import { useEffect, useId, useRef, useState } from 'react';
import type { Artifact } from '@messenger/contracts';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import styles from './Attachments.module.css';
import { useConversationFiles } from './useConversationFiles';

export function ArtifactLinks({
  chatId,
  artifacts,
}: {
  chatId: string;
  artifacts: Artifact[];
}) {
  return (
    <div className={styles.items}>
      {artifacts.map((artifact) => (
        <a
          className={styles.item}
          key={artifact.id}
          href={`/api/chats/${encodeURIComponent(chatId)}/artifacts/${encodeURIComponent(artifact.id)}`}
          download={artifact.name}
        >
          <Icon name="download" /> {artifact.name}{' '}
          <small>{Math.ceil(artifact.sizeBytes / 1024)} KB</small>
        </a>
      ))}
    </div>
  );
}
export function ArtifactCatalog({ chatId }: { chatId: string }) {
  return <ArtifactPanel key={chatId} chatId={chatId} />;
}
function ArtifactPanel({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const { shared, agent, busy, loading, refresh } = useConversationFiles(
    chatId,
    open,
  );
  const panelId = useId();
  const rail = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const element = rail.current;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    element?.addEventListener('keydown', dismiss);
    return () => element?.removeEventListener('keydown', dismiss);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  return (
    <aside
      ref={rail}
      className={styles.filesRail}
      aria-label="Conversation files sidebar"
    >
      <button
        ref={trigger}
        className={styles.filesTab}
        type="button"
        aria-label="Conversation files"
        title="Conversation files"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="file" />
      </button>
      <section
        id={panelId}
        aria-label="Conversation files"
        aria-hidden={!open}
        inert={!open}
        data-open={open}
        className={styles.filesPanel}
      >
        <header className={styles.filesHeader}>
          <h2>Conversation files</h2>
          <button
            type="button"
            aria-label="Close conversation files"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </header>
        <div className={styles.catalog}>
          {busy && loading ? (
            <div
              className={styles.filesLoading}
              role="status"
              aria-label="Loading conversation files"
            >
              <span className={styles.filesSpinner} aria-hidden="true">
                <Icon name="spinner" />
              </span>
              <span>Loading files…</span>
            </div>
          ) : null}
          <section
            className={styles.fileSection}
            aria-label="Shared with agent"
          >
            <h3>Shared with agent</h3>
            {shared.files?.length ? (
              <div className={styles.items}>
                {shared.files.map((file) => (
                  <span className={styles.item} key={file.uploadId}>
                    <Icon name="file" /> {file.name}{' '}
                    <small>{Math.ceil(file.size / 1024)} KB</small>
                  </span>
                ))}
              </div>
            ) : shared.loaded && !shared.error ? (
              <p>Files you send to this agent will appear here.</p>
            ) : null}
            <ErrorNotice
              message={shared.error ? `Shared files: ${shared.error}` : ''}
            />
            {shared.error ? (
              <Button
                busy={shared.busy}
                type="button"
                icon="refresh"
                onClick={() => refresh('shared')}
              >
                Retry shared files
              </Button>
            ) : null}
          </section>
          <section className={styles.fileSection} aria-label="From agent">
            <h3>From agent</h3>
            {agent.files?.length ? (
              <ArtifactLinks chatId={chatId} artifacts={agent.files} />
            ) : agent.loaded && !agent.error ? (
              <p>Files shared by this agent will appear here.</p>
            ) : null}
            <ErrorNotice
              message={agent.error ? `Agent files: ${agent.error}` : ''}
            />
            {agent.error ? (
              <Button
                busy={agent.busy}
                type="button"
                icon="refresh"
                onClick={() => refresh('agent')}
              >
                Retry agent files
              </Button>
            ) : null}
          </section>
          <Button
            busy={busy}
            icon="refresh"
            type="button"
            onClick={() => {
              refresh();
            }}
          >
            Refresh files
          </Button>
        </div>
      </section>
    </aside>
  );
}
