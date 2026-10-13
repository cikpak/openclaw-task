import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type {
  Attachment,
  ChatSettings,
  ModelCapability,
} from '@messenger/contracts';
import { AttachmentPicker } from '../attachments/AttachmentPicker';
import { commandId, errorMessage, request } from '../lib/api';
import { chatValid } from '../lib/validation';
import { ModelControls, selectModel } from '../settings/ModelControls';
import {
  useChatProjection,
  useModelCatalog,
  usePreferences,
} from '../state/stores';
import { ErrorNotice, Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import styles from '../settings/Settings.module.css';

const initialSettings: ChatSettings = {
  model: '',
  thinkingLevel: '',
  fastMode: false,
};
export function NewChat({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [creationId] = useState(commandId);
  const [step, setStep] = useState(1);
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [settings, setSettings] = useState<ChatSettings>(initialSettings);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const createdPath = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([
      useModelCatalog.getState().load(),
      usePreferences.getState().load(),
    ])
      .then(([catalog]) => {
        if (!active) return;
        setModels(catalog);
        const preferred =
          usePreferences.getState().preferences?.defaults ?? initialSettings;
        const selected =
          catalog.find((m) => m.id === preferred.model && m.available) ??
          catalog.find((m) => m.available);
        if (selected) setSettings(selectModel(preferred, selected));
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function createChat(close: () => void) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await request('/api/chats', {
        method: 'POST',
        body: JSON.stringify({
          commandId: creationId,
          settings,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(prompt.trim() || attachments.length
            ? {
                initialMessage: {
                  text: prompt,
                  uploadIds: attachments.map((a) => a.uploadId),
                },
              }
            : {}),
        }),
      });
      if (!chatValid(data))
        throw new Error(
          'Creation is unconfirmed. Check the chat list before trying again.',
        );
      useChatProjection.getState().mergeChat(data);
      createdPath.current = `/chat/${data.id}`;
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function refreshModels() {
    if (busy || loading) return;
    setRefreshing(true);
    setLoading(true);
    setError('');
    try {
      setModels(await useModelCatalog.getState().load());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  return (
    <Modal
      title="Start a conversation"
      onClose={() => {
        onClose();
        if (createdPath.current) void navigate(createdPath.current);
      }}
    >
      {(close) => (
        <>
          <p className={styles.hint}>
            Step {step} of 2 ·{' '}
            {step === 1 ? 'Choose your agent' : 'Give it a starting point'}
          </p>
          {loading ? (
            <p role="status">Loading available models…</p>
          ) : step === 1 ? (
            <ModelControls
              models={models}
              value={settings}
              onChange={setSettings}
            />
          ) : (
            <div className={styles.form}>
              <label>
                Name <span className={styles.optional}>optional</span>
                <input
                  value={name}
                  maxLength={100}
                  placeholder="e.g. Research partner"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                First message <span className={styles.optional}>optional</span>
                <textarea
                  value={prompt}
                  maxLength={32000}
                  rows={5}
                  placeholder="What would you like to work on?"
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              <AttachmentPicker
                onBusyChange={setUploading}
                attachments={attachments}
                onChange={setAttachments}
                disabled={busy}
              />
              <p className={styles.hint}>
                Leave the message empty to create an idle chat. Each
                conversation has its own agent and workspace.
              </p>
            </div>
          )}
          <ErrorNotice message={error} />
          {error || refreshing ? (
            <Button
              busy={refreshing}
              icon="refresh"
              type="button"
              disabled={busy || loading}
              onClick={() => {
                void refreshModels();
              }}
            >
              Refresh available models, keep my entries
            </Button>
          ) : null}
          <div className={styles.actions}>
            {step === 2 ? (
              <button type="button" onClick={() => setStep(1)} disabled={busy}>
                Back
              </button>
            ) : (
              <button type="button" onClick={close}>
                Cancel
              </button>
            )}
            <Button
              busy={busy}
              icon={step === 1 ? 'arrowRight' : 'plus'}
              className="primary"
              type="button"
              disabled={
                loading ||
                uploading ||
                busy ||
                !settings.model ||
                models.every((m) => !m.available)
              }
              onClick={() => {
                if (step === 1) setStep(2);
                else void createChat(close);
              }}
            >
              {step === 1 ? 'Continue' : 'Create chat'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
