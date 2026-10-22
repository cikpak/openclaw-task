import { opaqueToken, tokenHash, validToken } from './crypto.js';
import { fail, json } from './http.js';
import { createGrant } from './grants.js';
import { findSession, requireSession } from './sessions.js';
import { TICKET_LIFETIME } from './types.js';
import type { BackendEnv, Grant } from './types.js';

export async function issueConnectionTicket(
  env: BackendEnv,
  request: Request,
): Promise<Response> {
  if (!env.MANAGER)
    fail(503, 'AUTH_UNAVAILABLE', 'Connections are temporarily unavailable.');
  const session = await requireSession(env, request);
  const ticket = opaqueToken();
  const expiresAt = Date.now() + TICKET_LIFETIME;
  await env.AUTH_DB.prepare(
    `INSERT INTO connection_tickets
    (token_hash, session_id, origin, manager_id, expires_at)
    SELECT ?, id, ?, manager_id, ? FROM auth_sessions WHERE id = ? AND expires_at > ?`,
  )
    .bind(
      await tokenHash(ticket),
      env.APP_ORIGIN,
      expiresAt,
      session.id,
      Date.now(),
    )
    .run();
  return json({
    ticket,
    expiresAt,
    managerId: session.manager_id,
    address: '/ws/conversation',
  });
}

export async function consumeConnectionTicket(
  env: BackendEnv,
  ticket: string,
  sessionToken: string,
  managerId: string,
  origin: string,
): Promise<Grant> {
  if (
    !validToken(ticket) ||
    !validToken(sessionToken) ||
    origin !== env.APP_ORIGIN
  )
    fail(401, 'INVALID_TICKET', 'Connection authorization is invalid.');
  const now = Date.now();
  const sessionHash = await tokenHash(sessionToken);
  // All predicates are part of the deletion: invalid attempts cannot burn a valid ticket.
  const row = await env.AUTH_DB.prepare(
    `DELETE FROM connection_tickets
    WHERE token_hash = ? AND manager_id = ? AND origin = ? AND expires_at > ?
    AND EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = connection_tickets.session_id
      AND s.token_hash = ? AND s.manager_id = ? AND s.expires_at > ?)
    RETURNING session_id`,
  )
    .bind(
      await tokenHash(ticket),
      managerId,
      origin,
      now,
      sessionHash,
      managerId,
      now,
    )
    .first<{ session_id: string }>();
  if (!row)
    fail(
      401,
      'INVALID_TICKET',
      'Connection authorization is invalid or expired.',
    );
  const session = await findSession(env, sessionToken);
  if (!session || session.id !== row.session_id)
    fail(401, 'UNAUTHENTICATED', 'Session is no longer valid.');
  return createGrant(env, session);
}
