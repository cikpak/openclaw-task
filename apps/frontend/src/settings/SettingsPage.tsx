import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ChatSettings, ModelCapability } from '@messenger/contracts';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage } from '../lib/api';
import {
  chatSettingsEqual,
  chatSettingsSupported,
} from '../lib/agent-behavior';
import { useModelCatalog, useNotices, usePreferences } from '../state/stores';
import { ErrorNotice } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Select } from '../ui/Select';
import { ModelControls } from './ModelControls';
import { AgentBehaviorControls } from './AgentBehaviorControls';
import styles from './Settings.module.css';
export function SettingsPage() {
  const { logout } = useAuth();
  const [models, setModels] = useState<ModelCapability[]>([]);
  const [defaults, setDefaults] = useState<ChatSettings | null>(null);
  const [savedDefaults, setSavedDefaults] = useState<ChatSettings | null>(null);
  const [savedBehavior, setSavedBehavior] = useState<'queue' | 'steer'>(
    'queue',
  );
  const [etag, setEtag] = useState<string | null>(null);
  const [behavior, setBehavior] = useState<'queue' | 'steer'>('queue');
  const [error, setError] = useState('');
  const [action, setAction] = useState<'save' | 'refresh' | 'logout' | null>(
    null,
  );
  const busy = action !== null;
  const dirty =
    !!defaults &&
    !!savedDefaults &&
    (!chatSettingsEqual(defaults, savedDefaults) || behavior !== savedBehavior);
  const saveDisabled =
    busy ||
    !etag ||
    !defaults ||
    !dirty ||
    !chatSettingsSupported(defaults, models);
  const [refreshNote, setRefreshNote] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([
      useModelCatalog.getState().load(),
      usePreferences.getState().load(),
    ])
      .then(([catalog, loaded]) => {
        if (!active) return;
        setModels(catalog);
        setDefaults(loaded.preferences.defaults);
        setSavedDefaults(loaded.preferences.defaults);
        setBehavior(loaded.preferences.busySendBehavior);
        setSavedBehavior(loaded.preferences.busySendBehavior);
        setEtag(loaded.etag);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (!defaults || !etag || saveDisabled) return;
    setAction('save');
    setError('');
    try {
      const savedPreferences = await usePreferences
        .getState()
        .save({ defaults, busySendBehavior: behavior }, etag);
      setEtag(savedPreferences.etag);
      setDefaults(savedPreferences.preferences.defaults);
      setSavedDefaults(savedPreferences.preferences.defaults);
      setBehavior(savedPreferences.preferences.busySendBehavior);
      setSavedBehavior(savedPreferences.preferences.busySendBehavior);
      setRefreshNote('');
      useNotices.getState().add('Preferences saved.');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  async function refreshLatest() {
    if (busy) return;
    setAction('refresh');
    setError('');
    try {
      const [catalog, loaded] = await Promise.all([
        useModelCatalog.getState().load(undefined, true),
        usePreferences.getState().load(),
      ]);
      setModels(catalog);
      const latest = loaded.preferences;
      setEtag(loaded.etag);
      if (
        !defaults ||
        !savedDefaults ||
        chatSettingsEqual(defaults, savedDefaults)
      ) {
        setDefaults(latest.defaults);
      }
      if (behavior === savedBehavior) setBehavior(latest.busySendBehavior);
      setSavedDefaults(latest.defaults);
      setSavedBehavior(latest.busySendBehavior);
      setRefreshNote(
        `Latest saved defaults: ${latest?.defaults.model ?? 'none'}, ${latest?.defaults.thinkingLevel ?? 'none'} thinking, ${latest?.busySendBehavior ?? 'queue'} sending. Your edits are kept. Review them before saving again.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAction(null);
    }
  }
  return (
    <main className={styles.page}>
      <Link to="/" className={styles.back}>
        <Icon name="arrowLeft" /> Conversations
      </Link>
      <p className="eyebrow">YOUR WORKSPACE</p>
      <h1>Application settings</h1>
      <p className={styles.subtitle}>
        Set the starting point for new agents. Existing conversations keep their
        own model and behavior settings.
      </p>
      <section className={styles.section}>
        <h2>When an agent is working</h2>
        <div className={styles.labelBlock}>
          Default send behavior
          <Select
            label="Default send behavior"
            value={behavior}
            disabled={busy || !etag}
            onChange={(value) => {
              setBehavior(value === 'steer' ? 'steer' : 'queue');
            }}
            options={[
              {
                value: 'queue',
                label: 'Queue · wait for the current work to finish',
              },
              { value: 'steer', label: 'Steer · guide the current run' },
            ]}
          />
        </div>
      </section>
      <section className={styles.section}>
        <h2>New conversation defaults</h2>
        <div className={styles.defaultsContent} aria-busy={!defaults}>
          {defaults ? (
            <>
              <ModelControls
                models={models}
                value={defaults}
                disabled={busy || !etag}
                onChange={setDefaults}
              />
              <AgentBehaviorControls
                value={defaults}
                disabled={busy || !etag}
                onChange={setDefaults}
              />
              <p className={styles.behaviorScope}>
                Copied into new agents only. Later global changes do not affect
                existing agents.
              </p>
            </>
          ) : (
            <p role="status">Loading preferences…</p>
          )}
        </div>
      </section>
      <ErrorNotice message={error} />
      {error || action === 'refresh' ? (
        <Button
          busy={action === 'refresh'}
          icon="refresh"
          type="button"
          disabled={busy}
          onClick={() => {
            void refreshLatest();
          }}
        >
          Refresh latest values and models, keep my edits
        </Button>
      ) : null}
      {refreshNote ? (
        <p role="status" className={styles.status}>
          {refreshNote}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          busy={action === 'logout'}
          icon="logout"
          type="button"
          onClick={() => {
            if (busy) return;
            setAction('logout');
            void logout().catch((cause) => {
              setError(errorMessage(cause));
              setAction(null);
            });
          }}
          disabled={busy}
        >
          Sign out
        </Button>
        <Button
          busy={action === 'save'}
          icon="check"
          className="primary"
          type="button"
          onClick={() => {
            void save();
          }}
          disabled={saveDisabled}
        >
          Save preferences
        </Button>
      </div>
    </main>
  );
}
