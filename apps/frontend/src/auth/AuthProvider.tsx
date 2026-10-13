import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { SessionState } from '@messenger/contracts';
import { request } from '../lib/api';
import { record } from '../lib/validation';
import {
  useChatProjection,
  useDrafts,
  useModelCatalog,
  usePreferences,
} from '../state/stores';

interface AuthContextValue {
  session: SessionState | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const { data } = await request('/api/session');
      if (!record(data) || typeof data.authenticated !== 'boolean')
        throw new Error('Authentication service returned an invalid response.');
      setSession({
        authenticated: data.authenticated,
        ...(typeof data.username === 'string'
          ? { username: data.username }
          : {}),
      });
      setError('');
    } catch {
      setError(
        'Cannot reach the sign-in service. Check the connection and retry.',
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  async function login(username: string, password: string) {
    await request('/api/session', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    await refresh();
  }
  async function logout() {
    await request('/api/session', { method: 'DELETE' });
    useChatProjection.getState().clear();
    useDrafts.getState().clear();
    useModelCatalog.getState().clear();
    usePreferences.getState().clear();
    setSession({ authenticated: false });
  }
  return (
    <AuthContext value={{ session, loading, error, refresh, login, logout }}>
      {children}
    </AuthContext>
  );
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing.');
  return context;
}
