import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthenticationError } from '../errors.js';

// Development-only bridge while the legacy server owns both session and socket.
// Production tickets live in D1 and are consumed by the separate manager.
export function registerConnectionTickets(
  app: FastifyInstance,
  sessionId: (request: FastifyRequest) => string,
  origin: string,
) {
  const tickets = new Map<string, { session: string; expiresAt: number }>();
  app.post('/api/connection-tickets', async (request, reply) => {
    const session = sessionId(request);
    const now = Date.now();
    for (const [key, value] of tickets)
      if (value.expiresAt <= now) tickets.delete(key);
    while (tickets.size >= 1000) tickets.delete(tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = now + 60000;
    tickets.set(ticket, { session, expiresAt });
    return reply.header('Cache-Control', 'no-store').send({
      ticket,
      address: '/ws/conversation',
      expiresAt,
    });
  });
  return (request: FastifyRequest): Promise<void> => {
    const query = new URL(request.url, origin).searchParams;
    // Existing local automation uses the legacy cookie admission path.
    // The production manager has no cookie admission path.
    if (!query.has('ticket')) return Promise.resolve();
    if (request.headers.origin !== origin) throw new AuthenticationError();
    const ticket = query.get('ticket') ?? '';
    const authorization = tickets.get(ticket);
    tickets.delete(ticket);
    if (
      !authorization ||
      authorization.expiresAt <= Date.now() ||
      authorization.session !== sessionId(request)
    )
      throw new AuthenticationError();
    return Promise.resolve();
  };
}
