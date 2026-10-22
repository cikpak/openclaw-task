import { fail } from './http.js';
import { GRANT_LIFETIME } from './types.js';
import type { BackendEnv, Grant, Session } from './types.js';

interface GrantRow {
  id: string;
  session_id: string;
  account_id: string;
  manager_id: string;
  expires_at: number;
}

export function grantDto(row: GrantRow): Grant {
  return {
    id: row.id,
    sessionId: row.session_id,
    accountId: row.account_id,
    managerId: row.manager_id,
    expiresAt: row.expires_at,
  };
}

export async function createGrant(
  env: BackendEnv,
  session: Session,
): Promise<Grant> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = Math.min(now + GRANT_LIFETIME, session.expires_at);
  // The session can be revoked between admission and this insertion.
  const row = await env.AUTH_DB.prepare(
    `INSERT INTO manager_grants
    (id, session_id, account_id, manager_id, expires_at)
    SELECT ?, id, account_id, manager_id, MIN(expires_at, ?) FROM auth_sessions
    WHERE id = ? AND expires_at > ? RETURNING *`,
  )
    .bind(id, expiresAt, session.id, now)
    .first<GrantRow>();
  if (!row) fail(401, 'UNAUTHENTICATED', 'Session is no longer valid.');
  return grantDto(row);
}

export async function checkGrant(
  env: BackendEnv,
  id: string,
  managerId: string,
): Promise<Grant> {
  const now = Date.now();
  const row = await env.AUTH_DB.prepare(
    `SELECT g.* FROM manager_grants g
    JOIN auth_sessions s ON s.id = g.session_id
    WHERE g.id = ? AND g.manager_id = ? AND s.manager_id = ?
    AND g.expires_at > ? AND s.expires_at > ?`,
  )
    .bind(id, managerId, managerId, now, now)
    .first<GrantRow>();
  return row
    ? grantDto(row)
    : fail(401, 'INVALID_GRANT', 'Authorization is no longer valid.');
}

export async function renewGrant(
  env: BackendEnv,
  id: string,
  managerId: string,
): Promise<Grant> {
  const now = Date.now();
  const row = await env.AUTH_DB.prepare(
    `UPDATE manager_grants SET expires_at = MIN(?,
    (SELECT expires_at FROM auth_sessions WHERE id = manager_grants.session_id))
    WHERE id = ? AND manager_id = ? AND expires_at > ? AND EXISTS
    (SELECT 1 FROM auth_sessions s WHERE s.id = manager_grants.session_id
      AND s.manager_id = ? AND s.expires_at > ?) RETURNING *`,
  )
    .bind(now + GRANT_LIFETIME, id, managerId, now, managerId, now)
    .first<GrantRow>();
  return row
    ? grantDto(row)
    : fail(401, 'INVALID_GRANT', 'Authorization is no longer valid.');
}
