/* eslint-disable @typescript-eslint/require-await */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../errors.js';
import { verifyPassword } from '../auth/password.js';
import { problemSchema } from '../schemas.js';
import type { LegacyContext } from './context.js';

const sessionResponse = z.object({
  authenticated: z.boolean(),
  username: z.string().optional(),
  expiresAt: z.number().optional(),
});
export function registerSessions(context: LegacyContext) {
  const {
    app,
    config,
    store,
    gateway,
    chats,
    sessionId,
    sessionSockets,
    protectedRoute,
  } = context;
  app.get(
    '/health',
    { schema: { response: { 200: z.object({ status: z.literal('alive') }) } } },
    async () => ({ status: 'alive' as const }),
  );
  const readyResponse = z.object({ status: z.enum(['ready', 'initializing']) });
  app.get(
    '/ready',
    { schema: { response: { 200: readyResponse, 503: readyResponse } } },
    async (_request, reply) => {
      const ready = gateway.ready && chats.reconciled;
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? 'ready' : 'initializing' });
    },
  );
  app.get(
    '/api/session',
    { schema: { response: { 200: sessionResponse } } },
    async (request) => {
      const id = request.session.get('sessionId');
      return id && store.sessionValid(id)
        ? {
            authenticated: true,
            username: config.username,
            expiresAt: request.session.get('expiresAt'),
          }
        : { authenticated: false };
    },
  );
  app.post(
    '/api/session',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: z.object({
          username: z.string().max(256),
          password: z.string().min(1).max(1024),
        }),
        response: { 200: sessionResponse, 401: problemSchema },
      },
    },
    async (request, reply) => {
      const passwordValid = await verifyPassword(
        request.body.password,
        config.passwordHash,
      );
      if (!passwordValid || request.body.username !== config.username)
        throw new ApplicationError(
          401,
          'INVALID_CREDENTIALS',
          'The username or password is incorrect.',
        );
      const previous = request.session.get('sessionId');
      if (previous) {
        store.revokeSession(previous);
        for (const socket of sessionSockets.get(previous) ?? [])
          socket.close(1008, 'Session replaced');
      }
      const id = randomUUID();
      const expiresAt = Date.now() + config.sessionLifetimeSeconds * 1000;
      store.createSession(id, expiresAt);
      request.session.set('sessionId', id);
      request.session.set('expiresAt', expiresAt);
      return reply.send({
        authenticated: true,
        username: config.username,
        expiresAt,
      });
    },
  );
  app.delete(
    '/api/session',
    { preHandler: protectedRoute },
    async (request, reply) => {
      const id = sessionId(request);
      store.revokeSession(id);
      for (const socket of sessionSockets.get(id) ?? [])
        socket.close(1008, 'Session revoked');
      request.session.delete();
      return reply.code(204).send();
    },
  );
}
