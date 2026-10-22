import { opaqueToken, tokenHash, validToken } from './crypto.js';
import { checkGrant, createGrant } from './grants.js';
import { fail } from './http.js';
import { findSession } from './sessions.js';
import { TICKET_LIFETIME } from './types.js';
import type { BackendEnv, Grant } from './types.js';

export async function issueDownload(
  env: BackendEnv,
  grantId: string,
  managerId: string,
  fileId: string,
): Promise<{ ticket: string; expiresAt: number }> {
  const grant = await checkGrant(env, grantId, managerId);
  const ticket = opaqueToken();
  const expiresAt = Date.now() + TICKET_LIFETIME;
  const row = await env.AUTH_DB.prepare(
    `INSERT INTO download_tickets
    (token_hash, session_id, account_id, manager_id, file_id, expires_at)
    SELECT ?, s.id, s.account_id, s.manager_id, ?, ? FROM auth_sessions s
    JOIN manager_grants g ON g.session_id = s.id
    WHERE s.id = ? AND s.expires_at > ? AND g.id = ? AND g.manager_id = ? AND g.expires_at > ?
    RETURNING token_hash`,
  )
    .bind(
      await tokenHash(ticket),
      fileId,
      expiresAt,
      grant.sessionId,
      Date.now(),
      grantId,
      managerId,
      Date.now(),
    )
    .first<{ token_hash: string }>();
  if (!row) fail(401, 'INVALID_GRANT', 'Authorization is no longer valid.');
  return { ticket, expiresAt };
}

export async function consumeDownload(
  env: BackendEnv,
  ticket: string,
  sessionToken: string,
  managerId: string,
): Promise<{ grant: Grant; fileId: string }> {
  if (!validToken(ticket) || !validToken(sessionToken))
    fail(401, 'INVALID_TICKET', 'Download authorization is invalid.');
  const now = Date.now();
  const row = await env.AUTH_DB.prepare(
    `DELETE FROM download_tickets
    WHERE token_hash = ? AND manager_id = ? AND expires_at > ? AND EXISTS
    (SELECT 1 FROM auth_sessions s WHERE s.id = download_tickets.session_id
      AND s.token_hash = ? AND s.manager_id = ? AND s.expires_at > ?)
    RETURNING session_id, file_id`,
  )
    .bind(
      await tokenHash(ticket),
      managerId,
      now,
      await tokenHash(sessionToken),
      managerId,
      now,
    )
    .first<{ session_id: string; file_id: string }>();
  if (!row)
    fail(
      401,
      'INVALID_TICKET',
      'Download authorization is invalid or expired.',
    );
  const session = await findSession(env, sessionToken);
  if (!session || session.id !== row.session_id)
    fail(401, 'UNAUTHENTICATED', 'Session is no longer valid.');
  // Admission is independent of the originating socket grant. The manager may finish
  // this admitted transfer even when this newly issued grant subsequently expires.
  return { grant: await createGrant(env, session), fileId: row.file_id };
}
