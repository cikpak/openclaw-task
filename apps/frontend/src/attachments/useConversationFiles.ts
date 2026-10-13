import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, Attachment } from '@messenger/contracts';
import { errorMessage, request } from '../lib/api';
import { artifactValid, attachmentValid, record } from '../lib/validation';
import { useChatProjection } from '../state/stores';

type Source = 'shared' | 'agent';
type Section<T> = {
  files: T[] | null;
  busy: boolean;
  loaded: boolean;
  error: string;
};
type Catalog = { shared: Section<Attachment>; agent: Section<Artifact> };
const emptySection = { files: null, busy: false, loaded: false, error: '' };
const sources: Source[] = ['shared', 'agent'];
function updateToken(chatId: string) {
  const state = useChatProjection.getState();
  const snapshot = state.snapshots[chatId];
  return JSON.stringify([
    state.chats[chatId]?.updatedAt,
    snapshot?.chat.updatedAt,
    snapshot?.messages.at(-1)?.id,
    snapshot?.activeRun?.id,
    snapshot?.settledRun?.id,
    snapshot?.settledRun?.state,
    snapshot?.pending.map((item) => `${item.id}:${item.state}`).join('|'),
  ]);
}
export function useConversationFiles(chatId: string, open: boolean) {
  const [catalog, setCatalog] = useState<Catalog>({
    shared: emptySection,
    agent: emptySection,
  });
  const pending = useRef<Record<Source, AbortController | null>>({
    shared: null,
    agent: null,
  });
  const dirty = useRef<Record<Source, boolean>>({
    shared: false,
    agent: false,
  });
  const openRef = useRef(false);
  const lastToken = useRef<string | null>(null);
  const refresh = useCallback(
    (source?: Source, afterUpdate = false): void => {
      if (!openRef.current) return;
      for (const key of source ? [source] : sources) {
        if (pending.current[key]) {
          if (afterUpdate) dirty.current[key] = true;
          continue;
        }
        const controller = new AbortController();
        dirty.current[key] = false;
        pending.current[key] = controller;
        setCatalog((state) => ({
          ...state,
          [key]: { ...state[key], busy: true },
        }));
        void request(
          `/api/chats/${encodeURIComponent(chatId)}/${key === 'shared' ? 'shared-files' : 'artifacts'}`,
          { signal: controller.signal },
        )
          .then(({ data }) => {
            if (controller.signal.aborted) return;
            if (key === 'shared') {
              if (
                !record(data) ||
                !Array.isArray(data.files) ||
                data.files.length > 100 ||
                !data.files.every(attachmentValid)
              )
                throw new Error('Shared files could not be loaded.');
              setCatalog((state) => ({
                ...state,
                shared: {
                  ...state.shared,
                  files: data.files as Attachment[],
                  error: '',
                },
              }));
            } else {
              if (
                !record(data) ||
                !Array.isArray(data.artifacts) ||
                data.artifacts.length > 100 ||
                !data.artifacts.every(artifactValid)
              )
                throw new Error('Agent files could not be loaded.');
              setCatalog((state) => ({
                ...state,
                agent: {
                  ...state.agent,
                  files: data.artifacts as Artifact[],
                  error: '',
                },
              }));
            }
          })
          .catch((cause) => {
            if (!controller.signal.aborted)
              setCatalog((state) => ({
                ...state,
                [key]: { ...state[key], error: errorMessage(cause) },
              }));
          })
          .finally(() => {
            if (controller.signal.aborted) return;
            pending.current[key] = null;
            setCatalog((state) => ({
              ...state,
              [key]: { ...state[key], busy: false, loaded: true },
            }));
            if (dirty.current[key] && openRef.current) refresh(key);
          });
      }
    },
    [chatId],
  );
  useEffect(
    () => () => {
      openRef.current = false;
      lastToken.current = null;
      for (const key of sources) {
        pending.current[key]?.abort();
        pending.current[key] = null;
      }
    },
    [],
  );
  useEffect(() => {
    openRef.current = open;
    if (!open) return;
    const current = updateToken(chatId);
    if (
      lastToken.current !== current ||
      dirty.current.shared ||
      dirty.current.agent
    ) {
      lastToken.current = current;
      refresh(undefined, true);
    }
    return useChatProjection.subscribe(() => {
      const next = updateToken(chatId);
      if (next === lastToken.current) return;
      lastToken.current = next;
      refresh(undefined, true);
    });
  }, [chatId, open, refresh]);
  return {
    ...catalog,
    busy: catalog.shared.busy || catalog.agent.busy,
    loading: !(catalog.shared.loaded && catalog.agent.loaded),
    refresh,
  };
}
