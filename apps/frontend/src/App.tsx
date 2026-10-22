import { useEffect, useState } from 'react';
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router';
import { useAuth } from './auth/AuthProvider';
import { NewChat } from './chats/NewChat';
import { ChatStatusDot } from './chats/ChatStatusDot';
import { ConnectionProvider } from './conversation/ConnectionProvider';
import { ConversationPage } from './conversation/ConversationPage';
import { errorMessage, request } from './lib/api';
import { chatValid, record } from './lib/validation';
import { SettingsPage } from './settings/SettingsPage';
import { useChatProjection, useNotices, usePreferences } from './state/stores';
import { ErrorNotice } from './ui/Modal';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';
import { PageTitle } from './ui/PageTitle';
import { Toast } from './ui/Toast';
import styles from './App.module.css';
function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <main className={styles.login}>
      <div className={styles.loginPanel}>
        <section className={styles.loginForm} aria-labelledby="login-title">
          <span className="eyebrow">WELCOME BACK</span>
          <h2 id="login-title">Make yourself at home.</h2>
          <p>Sign in to your OpenClaw workspace.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              void login(username, password)
                .catch((cause) => setError(errorMessage(cause)))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Username
              <input
                autoComplete="username"
                value={username}
                required
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                required
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <ErrorNotice message={error} />
            <Button
              className="primary"
              type="submit"
              busy={busy}
              icon="arrowRight"
            >
              Sign in
            </Button>
          </form>
        </section>
      </div>
      <div className={styles.loginIntro}>
        <div>
          <Link to="/" className={styles.brand}>
            ✳ <span>openclaw</span>
          </Link>
          <h1>
            A place for
            <br />
            your next idea.
          </h1>
          <p>
            Independent agents.
            <br />
            Conversations that keep moving.
          </p>
        </div>
      </div>
    </main>
  );
}
function ProtectedShell() {
  const { session } = useAuth();
  const chats = useChatProjection((state) => state.chats);
  const connection = useChatProjection((state) =>
    state.transport === 'closed'
      ? 'unavailable'
      : state.transport === 'connecting'
        ? 'connecting'
        : state.connection,
  );
  const [newChat, setNewChat] = useState(false);
  const [error, setError] = useState('');
  const location = useLocation();
  const notices = useNotices((state) => state.notices);
  useEffect(() => {
    let active = true;
    const sequence = useChatProjection.getState().sequence;
    const epoch = useChatProjection.getState().connectionEpoch;
    void request('/api/chats')
      .then(({ data }) => {
        if (!active) return;
        if (
          !record(data) ||
          !Array.isArray(data.chats) ||
          !data.chats.every(chatValid)
        )
          throw new Error('Conversation list could not be loaded.');
        if (
          useChatProjection.getState().sequence === sequence &&
          useChatProjection.getState().connectionEpoch === epoch
        )
          useChatProjection.getState().replaceCatalog(data.chats);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    void usePreferences
      .getState()
      .load()
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, []);
  const ordered = Object.values(chats).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const isDetail = location.pathname !== '/';
  return (
    <div className={`${styles.shell} ${isDetail ? styles.detailRoute : ''}`}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} to="/">
          ✳ <span>openclaw</span>
        </Link>
        <div className={styles.sidebarIntro}>
          <span className="eyebrow">CONVERSATIONS</span>
          <span className={styles.count}>{ordered.length} / 10</span>
        </div>
        <button
          type="button"
          className={styles.newChat}
          disabled={ordered.length >= 10}
          onClick={() => setNewChat(true)}
        >
          <Icon name="plus" /> New conversation
        </button>
        {ordered.length >= 10 ? (
          <p className={styles.capacity}>All ten agent spaces are in use.</p>
        ) : null}
        <nav aria-label="Conversations" className={styles.chatList}>
          {ordered.map((chat) => (
            <NavLink
              to={`/chat/${chat.id}`}
              key={chat.id}
              className={({ isActive }) =>
                `${styles.chatItem} ${isActive ? styles.selected : ''}`
              }
            >
              <ChatStatusDot chat={chat} />
              <div>
                <strong>{chat.name}</strong>
                <span>
                  {chat.status === 'running'
                    ? 'Working on it…'
                    : chat.status === 'recovery'
                      ? 'Needs attention'
                      : chat.settings.model.split('/').at(-1)}
                </span>
              </div>
              {chat.unread ? (
                <span className={styles.unread} aria-label="Unread messages" />
              ) : null}
            </NavLink>
          ))}
        </nav>
        {ordered.length === 0 ? (
          <p className={styles.sidebarEmpty}>
            Your conversations will live here.
            <br />
            Start one when inspiration strikes.
          </p>
        ) : null}
        <ErrorNotice message={error} />
        <footer className={styles.sidebarFooter}>
          <span className={styles.connection} role="status">
            <i
              className={styles[connection]}
              data-connection-state={connection}
              aria-hidden="true"
            />
            {connection === 'ready'
              ? 'Connected'
              : connection === 'connecting'
                ? 'Connecting…'
                : 'Connection unavailable'}
          </span>
          <Link to="/settings" className={styles.preferences}>
            <Icon name="settings" /> Settings{' '}
            <small>{session?.username ?? 'Workspace'}</small>
          </Link>
        </footer>
      </aside>
      <div className={styles.content}>
        <Outlet />
      </div>
      {connection === 'unavailable' ? (
        <div className={styles.offline} role="status">
          The connection is unavailable. Conversations will reconnect
          automatically; drafts are kept.
        </div>
      ) : null}
      {newChat ? <NewChat onClose={() => setNewChat(false)} /> : null}
      <div className={styles.toasts} aria-live="polite">
        {notices.map((notice) => (
          <Toast
            key={notice.id}
            text={notice.text}
            onDismiss={() => useNotices.getState().dismiss(notice.id)}
          />
        ))}
      </div>
    </div>
  );
}
function Home() {
  const [newChat, setNewChat] = useState(false);
  const count = useChatProjection((state) => Object.keys(state.chats).length);
  return (
    <main className={styles.home}>
      <h1>
        Your agents.
        <br />
        Your next chapter.
      </h1>
      <p>
        One conversation for each thing on your mind.
        <br />
        Choose a chat, or give a new agent something to explore.
      </p>
      <button
        className="primary"
        disabled={count >= 10}
        type="button"
        onClick={() => setNewChat(true)}
      >
        Start a conversation <Icon name="arrowUpRight" />
      </button>
      <div className={styles.homeNote}>
        <span aria-hidden="true">✳</span>
        <p>
          Each agent has its own context and workspace.
          <br />
          Your work stays with the conversation.
        </p>
      </div>
      {newChat ? <NewChat onClose={() => setNewChat(false)} /> : null}
    </main>
  );
}
function AppContent() {
  const { session, loading, error, refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);
  if (loading)
    return (
      <main className={styles.startup}>
        <p className="eyebrow">OPENCLAW</p>
        <h1>Opening your workspace…</h1>
      </main>
    );
  if (error)
    return (
      <main className={styles.startup}>
        <h1>Workspace unavailable</h1>
        <ErrorNotice message={error} />
        <Button
          busy={retrying}
          icon="refresh"
          type="button"
          onClick={() => {
            setRetrying(true);
            void refresh().finally(() => setRetrying(false));
          }}
        >
          Try again
        </Button>
      </main>
    );
  if (!session?.authenticated)
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  return (
    <ConnectionProvider>
      <Routes>
        <Route element={<ProtectedShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/chat/:chatId" element={<ConversationPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ConnectionProvider>
  );
}
export function App() {
  return (
    <PageTitle>
      <AppContent />
    </PageTitle>
  );
}
