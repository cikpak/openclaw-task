import { useEffect, useState } from 'react';
import type {
  ChatSettings,
  ChatSnapshot,
  ModelCapability,
} from '@messenger/contracts';
import { commandId, errorMessage, request, resourceTag } from '../lib/api';
import { chatValid } from '../lib/validation';
import {
  chatSettingsEqual,
  chatSettingsSupported,
} from '../lib/agent-behavior';
import { useConversation } from '../conversation/ConnectionProvider';
import {
  useChatProjection,
  useModelCatalog,
  useNotices,
} from '../state/stores';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useDialogMotion } from '../ui/useDialogMotion';
import motion from '../ui/Ui.module.css';
import { ModelControls } from './ModelControls';
import { AgentBehaviorControls } from './AgentBehaviorControls';
import styles from './Settings.module.css';
export function ChatSettingsPanel({
  snapshot,
  onClose,
}: {
  snapshot: ChatSnapshot;
  onClose: () => void;
}) {
  const send = useConversation();
  const [name, setName] = useState(snapshot.chat.name);
  const [savedName, setSavedName] = useState(snapshot.chat.name);
  const [settings, setSettings] = useState<ChatSettings>(
    snapshot.chat.settings,
  );
  const [savedSettings, setSavedSettings] = useState(snapshot.chat.settings);
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [etag, setEtag] = useState(resourceTag(snapshot.chat.version));
  const [error, setError] = useState('');
  const [action, setAction] = useState<string | null>(null);
  const busy = action !== null;
  const [initialRead, setInitialRead] = useState<
    'loading' | 'ready' | 'failed'
  >('loading');
  const [choosePolicy, setChoosePolicy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const { dialog, closing, close } = useDialogMotion(onClose);
  useEffect(() => {
    let active = true;
    void useModelCatalog
      .getState()
      .load(snapshot.chat.id)
      .then((catalog) => {
        if (!active) return;
        setModels(catalog);
        setCatalogReady(true);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    void request(`/api/chats/${snapshot.chat.id}`)
      .then((response) => {
        if (!active) return;
        if (chatValid(response.data)) {
          setName(response.data.name);
          setSavedName(response.data.name);
          setSettings(response.data.settings);
          setSavedSettings(response.data.settings);
          setEtag(response.etag ?? resourceTag(response.data.version));
          setInitialRead('ready');
        } else throw new Error('Settings could not be loaded.');
      })
      .catch((cause) => {
        if (active) {
          setError(errorMessage(cause));
          setInitialRead('failed');
        }
      });
    return () => {
      active = false;
    };
  }, [snapshot.chat.id]);
  const occupied =
    !!snapshot.activeRun ||
    snapshot.pending.some((p) => p.state !== 'cancelled');
  const mutationDisabled = busy || initialRead !== 'ready';
  const controlsDisabled = mutationDisabled || !catalogReady;
  const settingsDirty = !chatSettingsEqual(settings, savedSettings);
  const dirty = name.trim() !== savedName || settingsDirty;
  const saveDisabled =
    controlsDisabled ||
    !dirty ||
    !name.trim() ||
    (settingsDirty && !chatSettingsSupported(settings, models)) ||
    (!!snapshot.pendingSettings &&
      snapshot.pendingSettings.status !== 'failed');
  async function save(policy: 'when-idle' | 'cancel-work') {
    if (saveDisabled) return;
    setError('');
    setAction(`save-${policy}`);
    try {
      let tag = etag;
      if (name.trim() !== savedName) {
        const response = await request(`/api/chats/${snapshot.chat.id}`, {
          method: 'PATCH',
          headers: { 'If-Match': tag },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (!chatValid(response.data))
          throw new Error(
            'Rename response was invalid. Reload before retrying.',
          );
        useChatProjection.getState().mergeChat(response.data);
        tag = response.etag ?? resourceTag(response.data.version);
        setEtag(tag);
        setSavedName(response.data.name);
        setName(response.data.name);
      }
      if (settingsDirty) {
        const response = await request(
          `/api/chats/${snapshot.chat.id}/settings`,
          {
            method: 'PATCH',
            headers: { 'If-Match': tag },
            body: JSON.stringify({ settings, policy }),
          },
        );
        if (response.etag) setEtag(response.etag);
        setSavedSettings(settings);
      }
      await send({
        type: 'conversation.snapshot.request',
        commandId: commandId(),
        chatId: snapshot.chat.id,
      });
      useNotices
        .getState()
        .add(
          settingsDirty
            ? 'Settings change accepted. Its status appears in the conversation.'
            : 'Conversation name saved.',
        );
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  async function deleteChat() {
    if (mutationDisabled) return;
    setAction('delete');
    setError('');
    try {
      await request(`/api/chats/${snapshot.chat.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': etag },
      });
      close();
      useNotices
        .getState()
        .add(
          'Chat deletion accepted. Its active and queued work will be cancelled.',
        );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  async function recoverSettings(action: 'retry' | 'discard') {
    if (mutationDisabled) return;
    setAction(action);
    setError('');
    try {
      await request(`/api/chats/${snapshot.chat.id}/settings/recovery`, {
        method: 'POST',
        headers: { 'If-Match': etag },
        body: JSON.stringify({ action }),
      });
      await send({
        type: 'conversation.snapshot.request',
        commandId: commandId(),
        chatId: snapshot.chat.id,
      });
      useNotices
        .getState()
        .add(
          action === 'retry'
            ? 'Settings recovery requested.'
            : 'Pending settings discarded after checking the effective settings.',
        );
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  async function refreshLatest() {
    if (busy || initialRead === 'loading') return;
    setAction('refresh');
    setError('');
    setCatalogReady(false);
    try {
      const [catalogResult, localResult] = await Promise.allSettled([
        useModelCatalog.getState().load(snapshot.chat.id, true),
        request(`/api/chats/${snapshot.chat.id}`),
      ]);
      if (catalogResult.status === 'fulfilled') {
        setModels(catalogResult.value);
        setCatalogReady(true);
      } else setError(errorMessage(catalogResult.reason));
      if (localResult.status === 'rejected') throw localResult.reason;
      const chatResponse = localResult.value;
      if (!chatValid(chatResponse.data))
        throw new Error('Latest settings could not be loaded.');
      setEtag(chatResponse.etag ?? resourceTag(chatResponse.data.version));
      if (name.trim() === savedName) setName(chatResponse.data.name);
      setSavedName(chatResponse.data.name);
      if (initialRead !== 'ready' || !settingsDirty)
        setSettings(chatResponse.data.settings);
      setSavedSettings(chatResponse.data.settings);
      setInitialRead('ready');
      useChatProjection.getState().mergeChat(chatResponse.data);
      setRefreshNote(
        `Latest saved values: ${chatResponse.data.name}, ${chatResponse.data.settings.model}, ${chatResponse.data.settings.thinkingLevel} thinking. Your edits are kept. Review them before saving again.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  async function recoverCreation() {
    if (mutationDisabled) return;
    setAction('recover');
    setError('');
    try {
      const { data, etag: nextTag } = await request(
        `/api/chats/${snapshot.chat.id}/recovery`,
        { method: 'POST', headers: { 'If-Match': etag } },
      );
      if (!chatValid(data))
        throw new Error(
          'Agent recovery is unconfirmed. Refresh the conversation before retrying.',
        );
      useChatProjection.getState().mergeChat(data);
      setEtag(nextTag ?? resourceTag(data.version));
      await send({
        type: 'conversation.snapshot.request',
        commandId: commandId(),
        chatId: snapshot.chat.id,
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={`${styles.fullScreen} ${motion.dialogMotion}`}
      data-closing={closing || undefined}
      aria-labelledby="chat-settings-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <fieldset disabled={closing} className={styles.panel}>
        <header className={styles.panelHeader}>
          <h2 id="chat-settings-title">Agent settings</h2>
          <button type="button" onClick={close}>
            Close
          </button>
        </header>
        <p className={styles.subtitle}>
          Only this conversation’s agent is affected. Behavior changes apply to
          future runs, not previous messages.
        </p>
        {initialRead === 'loading' ? (
          <p role="status" className={styles.status}>
            Loading latest agent settings…
          </p>
        ) : null}
        {snapshot.pendingSettings ? (
          <p className={styles.status}>
            Settings operation: {snapshot.pendingSettings.status}. Model{' '}
            {snapshot.pendingSettings.settings.model},{' '}
            {snapshot.pendingSettings.settings.thinkingLevel} thinking.{' '}
            {snapshot.pendingSettings.policy === 'when-idle'
              ? 'Waiting for all work to finish.'
              : 'Cancelling work before applying.'}
          </p>
        ) : null}
        {snapshot.pendingSettings?.status === 'unknown' ? (
          <div className={styles.policy}>
            <p className={styles.hint}>
              The settings outcome is unconfirmed. Recovery checks the agent’s
              effective settings before proceeding.
            </p>
            <Button
              busy={action === 'retry'}
              type="button"
              disabled={mutationDisabled}
              onClick={() => {
                void recoverSettings('retry');
              }}
            >
              Retry pending change
            </Button>
            <Button
              busy={action === 'discard'}
              type="button"
              disabled={mutationDisabled}
              onClick={() => {
                void recoverSettings('discard');
              }}
            >
              Discard pending change
            </Button>
          </div>
        ) : null}
        <div className={styles.form}>
          <label>
            Conversation name
            <input
              value={name}
              maxLength={100}
              disabled={mutationDisabled}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ModelControls
            models={models}
            value={settings}
            onChange={setSettings}
            disabled={controlsDisabled}
          />
          <AgentBehaviorControls
            value={settings}
            onChange={setSettings}
            disabled={controlsDisabled}
          />
        </div>
        <ErrorNotice message={error} />
        <Button
          busy={action === 'refresh'}
          icon="refresh"
          type="button"
          disabled={busy || initialRead === 'loading'}
          onClick={() => {
            void refreshLatest();
          }}
        >
          Refresh latest values and models, keep my edits
        </Button>
        {refreshNote ? (
          <p role="status" className={styles.status}>
            {refreshNote}
          </p>
        ) : null}
        {snapshot.chat.status === 'recovery' &&
        snapshot.pending.every((message) => message.state === 'pending') &&
        !snapshot.pendingSettings ? (
          <div className={styles.status}>
            <p>
              Agent setup could not be confirmed. Retry checks the existing
              agent identity before continuing.
            </p>
            <Button
              busy={action === 'recover'}
              icon="refresh"
              type="button"
              disabled={mutationDisabled}
              onClick={() => {
                void recoverCreation();
              }}
            >
              Retry agent setup
            </Button>
          </div>
        ) : null}
        {choosePolicy ? (
          <div className={styles.policy}>
            <p className={styles.hint}>
              This agent has active or queued work. Choose when to apply these
              settings.
            </p>
            <Button
              busy={action === 'save-when-idle'}
              icon="check"
              className="primary"
              disabled={saveDisabled}
              type="button"
              onClick={() => {
                void save('when-idle');
              }}
            >
              Apply when all work is idle
            </Button>
            <Button
              busy={action === 'save-cancel-work'}
              icon="check"
              disabled={saveDisabled}
              type="button"
              onClick={() => {
                void save('cancel-work');
              }}
            >
              Cancel active and queued work, then apply
            </Button>
            <button
              disabled={busy}
              type="button"
              onClick={() => setChoosePolicy(false)}
            >
              Continue editing
            </button>
          </div>
        ) : (
          <div className={styles.actions}>
            <button type="button" onClick={close}>
              Cancel
            </button>
            <Button
              busy={action === 'save-when-idle'}
              icon="check"
              className="primary"
              type="button"
              disabled={saveDisabled}
              onClick={() => {
                if (occupied && settingsDirty) setChoosePolicy(true);
                else void save('when-idle');
              }}
            >
              Save changes
            </Button>
          </div>
        )}
        <section className={styles.section}>
          <h3>Delete conversation</h3>
          <p className={styles.hint}>
            Cancels this agent’s active and queued work and removes its
            workspace. This cannot be undone.
          </p>
          {deleteConfirm ? (
            <div className={styles.actions}>
              <button
                type="button"
                disabled={mutationDisabled}
                onClick={() => setDeleteConfirm(false)}
              >
                Keep conversation
              </button>
              <Button
                busy={action === 'delete'}
                icon="trash"
                type="button"
                className={styles.danger}
                disabled={mutationDisabled}
                onClick={() => {
                  void deleteChat();
                }}
              >
                Confirm deletion
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.danger}
              disabled={mutationDisabled}
              onClick={() => setDeleteConfirm(true)}
            >
              Delete conversation…
            </button>
          )}
        </section>
      </fieldset>
    </dialog>
  );
}
