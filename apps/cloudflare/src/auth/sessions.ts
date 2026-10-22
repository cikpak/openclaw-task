import {
  opaqueToken,
  passwordMatches,
  tokenHash,
  validToken,
} from './crypto.js';
import {
  body,
  fail,
  field,
  json,
  sessionCookie,
  sessionToken,
} from './http.js';
import { ACCOUNT_ID, MANAGER_ID } from './types.js';
import type { BackendEnv, Session } from './types.js';

export async function findSession(
  env: BackendEnv,
  token: string | null,
): Promise<Session | null> {
  if (!validToken(token)) return null;
  return env.AUTH_DB.prepare(
    'SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?',
  )
    .bind(await tokenHash(token), Date.now())
    .first<Session>();
}

export async function requireSession(
  env: BackendEnv,
  request: Request,
): Promise<Session> {
  const session = await findSession(env, sessionToken(request));
  return (
    session ?? fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.')
  );
}

export async function revokeSession(
  env: BackendEnv,
  id: string,
): Promise<void> {
  await env.AUTH_DB.prepare('DELETE FROM auth_sessions WHERE id = ?')
    .bind(id)
    .run();
  if (env.MANAGER) {
    // Revocation is already authoritative in D1. Expiring grants bound missed notifications.
    try {
      const response = await env.MANAGER.fetch(
        'https://manager/internal/revoke',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: id }),
        },
      );
      await response.body?.cancel();
    } catch {
      /* Manager reconnect checks remain fail closed. */
    }
  }
}

async function limitLogin(env: BackendEnv, request: Request): Promise<void> {
  const now = Date.now();
  const key = await tokenHash(
    `login:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`,
  );
  const row = await env.AUTH_DB.prepare(
    `INSERT INTO login_rate_limits(key_hash, window_start, attempts)
    VALUES (?, ?, 1) ON CONFLICT(key_hash) DO UPDATE SET
    attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
    window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    RETURNING attempts`,
  )
    .bind(key, now, now - 60_000, now - 60_000)
    .first<{ attempts: number }>();
  if (!row || row.attempts > 5)
    fail(
      429,
      'RATE_LIMITED',
      'Too many sign-in attempts. Try again in one minute.',
    );
}

async function prune(env: BackendEnv): Promise<void> {
  const now = Date.now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(
      now,
    ),
    env.AUTH_DB.prepare(
      'DELETE FROM connection_tickets WHERE expires_at <= ?',
    ).bind(now),
    env.AUTH_DB.prepare(
      'DELETE FROM download_tickets WHERE expires_at <= ?',
    ).bind(now),
    env.AUTH_DB.prepare(
      'DELETE FROM manager_grants WHERE expires_at <= ?',
    ).bind(now),
    env.AUTH_DB.prepare(
      'DELETE FROM login_rate_limits WHERE window_start < ?',
    ).bind(now - 300_000),
  ]);
}

export async function login(
  env: BackendEnv,
  request: Request,
): Promise<Response> {
  if (!env.MANAGER)
    fail(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
  await limitLogin(env, request);
  const data = await body(request);
  const username = field(data, 'username');
  const password = field(data, 'password', 1024);
  const valid = await passwordMatches(password, env.APP_PASSWORD_HASH);
  if (!valid || username !== env.APP_USERNAME)
    fail(401, 'INVALID_CREDENTIALS', 'The username or password is incorrect.');
  await prune(env);
  const previous = await findSession(env, sessionToken(request));
  if (previous) await revokeSession(env, previous.id);
  const configured = Number(env.SESSION_TTL_SECONDS ?? 86_400);
  if (
    !Number.isSafeInteger(configured) ||
    configured <= 0 ||
    configured > 86_400
  )
    fail(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable.');
  const token = opaqueToken();
  const now = Date.now();
  const expiresAt = now + configured * 1000;
  await env.AUTH_DB.prepare(
    `INSERT INTO auth_sessions
    (id, token_hash, account_id, manager_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await tokenHash(token),
      ACCOUNT_ID,
      MANAGER_ID,
      expiresAt,
      now,
    )
    .run();
  return json(
    { authenticated: true, username: env.APP_USERNAME, expiresAt },
    200,
    { 'Set-Cookie': sessionCookie(token, configured) },
  );
}

export async function getSession(
  env: BackendEnv,
  request: Request,
): Promise<Response> {
  const session = await findSession(env, sessionToken(request));
  return json(
    session
      ? {
          authenticated: true,
          username: env.APP_USERNAME,
          expiresAt: session.expires_at,
        }
      : { authenticated: false },
  );
}

export async function logout(
  env: BackendEnv,
  request: Request,
): Promise<Response> {
  const session = await findSession(env, sessionToken(request));
  if (session) await revokeSession(env, session.id);
  return new Response(null, {
    status: 204,
    headers: {
      'Cache-Control': 'no-store',
      'Set-Cookie': sessionCookie('', 0),
    },
  });
}
