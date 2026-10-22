/* Fastify async hooks and handlers must return promises, including synchronous persistence handlers. */
/* eslint-disable @typescript-eslint/require-await */
import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { Store } from './database.js';
import {
  ApplicationError,
  AuthenticationError,
  toProblem,
  ValidationError,
} from './errors.js';
import { verifyPassword } from './auth/password.js';
import { registerConnectionTickets } from './auth/connection-tickets.js';
import type { Gateway } from './gateway/types.js';
import { OpenClawGateway } from './gateway/openclaw.js';
import { ChatService, summary } from './chats/service.js';
import { parseOutboundFrame } from './outbound.js';
import { UploadService } from './uploads/service.js';
import { registerMediaRoutes } from './uploads/routes.js';
import {
  chatSchema,
  commandSchema,
  createChatSchema,
  preferencesSchema,
  problemSchema,
  settingsOperationSchema,
  settingsSchema,
} from './schemas.js';
declare module '@fastify/secure-session' {
  interface SessionData {
    sessionId: string;
    expiresAt: number;
  }
}
export interface ServerOptions {
  config: Config;
  gateway?: Gateway;
  store?: Store;
  logger?: boolean;
}
const sessionResponse = z.object({
  authenticated: z.boolean(),
  username: z.string().optional(),
  expiresAt: z.number().optional(),
});
export async function buildServer(options: ServerOptions) {
  const { config } = options;
  const store =
    options.store ?? new Store(join(config.dataDir, 'messenger.sqlite'));
  const gateway = options.gateway ?? new OpenClawGateway(config);
  const uploads = new UploadService(
    store,
    config.dataDir,
    config.username,
    gateway,
  );
  const chats = new ChatService(store, gateway, uploads);
  const app = Fastify({
    // Direct development trusts no headers. Compose exposes only the single Caddy hop.
    trustProxy:
      config.trustProxyHops === 1 ? (_address, hop) => hop === 0 : false,
    logger: options.logger
      ? {
          redact: {
            paths: [
              'req.url',
              'req.query.ticket',
              'req.headers.cookie',
              'req.headers.authorization',
              'req.body',
              'res.headers.set-cookie',
            ],
            censor: '[REDACTED]',
          },
        }
      : false,
    // 32,000 schema characters can require six JSON bytes each, plus metadata.
    bodyLimit: 262144,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(secureSession, {
    key: config.sessionKey,
    cookieName: config.secureCookies ? '__Host-messenger' : 'messenger',
    expiry: config.sessionLifetimeSeconds,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookies,
      maxAge: config.sessionLifetimeSeconds,
    },
  });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 262144 } });
  const sessionSockets = new Map<string, Set<WebSocket>>();
  function sessionId(request: FastifyRequest): string {
    const id = request.session.get('sessionId');
    if (!id || !store.sessionValid(id)) throw new AuthenticationError();
    return id;
  }
  const protectedRoute = (request: FastifyRequest): Promise<void> => {
    sessionId(request);
    return Promise.resolve();
  };
  const consumeConnectionTicket = registerConnectionTickets(
    app,
    sessionId,
    config.origin,
  );
  app.addHook('onRequest', async (request) => {
    if (
      ['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method) &&
      request.headers.origin !== config.origin
    )
      throw new ApplicationError(
        403,
        'ORIGIN_REJECTED',
        'The request origin is not allowed.',
      );
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/'))
      request.log = request.log.child({ correlationId: request.id });
  });
  app.setErrorHandler((error, request, reply) => {
    const statusError = error as { statusCode?: number; code?: string };
    // Zod failures in storage/upstream projections are server faults, not invalid client input.
    const validation =
      statusError.code === 'FST_ERR_VALIDATION' &&
      hasZodFastifySchemaValidationErrors(error);
    const parserErrors: Record<
      string,
      { status: number; code: string; detail: string }
    > = {
      FST_ERR_CTP_INVALID_JSON_BODY: {
        status: 400,
        code: 'INVALID_JSON',
        detail: 'The request body must contain valid JSON.',
      },
      FST_ERR_CTP_EMPTY_JSON_BODY: {
        status: 400,
        code: 'EMPTY_JSON_BODY',
        detail: 'Provide a JSON body or omit its content type.',
      },
      FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
        status: 400,
        code: 'INVALID_CONTENT_LENGTH',
        detail: 'The request body length is invalid.',
      },
      FST_ERR_CTP_BODY_TOO_LARGE: {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        detail: 'The request body exceeds the permitted size.',
      },
      FST_ERR_CTP_INVALID_MEDIA_TYPE: {
        status: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        detail: 'The request content type is not supported.',
      },
    };
    const parser = statusError.code
      ? parserErrors[statusError.code]
      : undefined;
    const safe = validation
      ? new ValidationError()
      : statusError.statusCode === 429
        ? new ApplicationError(
            429,
            'RATE_LIMITED',
            'Too many attempts. Try again shortly.',
          )
        : parser
          ? new ApplicationError(parser.status, parser.code, parser.detail)
          : error;
    const problem = toProblem(safe, request.id);
    if (problem.status === 500)
      request.log.error(
        { errorClass: error instanceof Error ? error.name : 'Unknown' },
        'Request failed',
      );
    void reply
      .code(problem.status)
      .type('application/problem+json')
      .send(problem);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type('application/problem+json')
      .send(
        toProblem(
          new ApplicationError(
            404,
            'NOT_FOUND',
            'The requested resource was not found.',
          ),
          request.id,
        ),
      );
  });
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
  app.get(
    '/api/chats',
    {
      preHandler: protectedRoute,
      schema: { response: { 200: z.object({ chats: z.array(chatSchema) }) } },
    },
    async () => ({ chats: store.listChats().map(summary) }),
  );
  app.post(
    '/api/chats',
    {
      preHandler: protectedRoute,
      schema: { body: createChatSchema, response: { 201: chatSchema } },
    },
    async (request, reply) => {
      const chat = await chats.create(request.body);
      return reply
        .code(201)
        .header('Location', `/api/chats/${chat.id}`)
        .header('ETag', `"${chat.version}"`)
        .send(chat);
    },
  );
  app.get(
    '/api/chats/:chatId',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        response: { 200: chatSchema },
      },
    },
    async (request, reply) => {
      const chat = summary(store.getChat(request.params.chatId));
      return reply.header('ETag', `"${chat.version}"`).send(chat);
    },
  );
  app.get(
    '/api/chats/:chatId/settings',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        response: {
          200: z.object({
            effective: settingsSchema,
            pending: settingsOperationSchema.nullable(),
            version: z.number(),
          }),
        },
      },
    },
    async (request, reply) => {
      const chat = store.getChat(request.params.chatId);
      return reply.header('ETag', `"${chat.version}"`).send({
        effective: chat.settings,
        pending: store.settingsOperation(chat.id),
        version: chat.version,
      });
    },
  );
  app.patch(
    '/api/chats/:chatId',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        body: z.object({ name: z.string().trim().min(1).max(100) }),
        response: { 200: chatSchema },
      },
    },
    async (request, reply) => {
      const chat = await chats.rename(
        request.params.chatId,
        request.body.name,
        request.headers['if-match'],
      );
      return reply.header('ETag', `"${chat.version}"`).send(chat);
    },
  );
  app.delete(
    '/api/chats/:chatId',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        response: { 202: z.object({ status: z.literal('deleting') }) },
      },
    },
    async (request, reply) => {
      await chats.delete(request.params.chatId, request.headers['if-match']);
      return reply.code(202).send({ status: 'deleting' as const });
    },
  );
  app.patch(
    '/api/chats/:chatId/settings',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        body: z.object({
          settings: settingsSchema,
          policy: z.enum(['when-idle', 'cancel-work']),
        }),
        response: { 202: settingsOperationSchema },
      },
    },
    async (request, reply) => {
      const operation = await chats.updateSettings(
        request.params.chatId,
        request.body.settings,
        request.body.policy,
        request.headers['if-match'],
      );
      return reply
        .code(202)
        .header('ETag', `"${store.getChat(request.params.chatId).version}"`)
        .send(operation);
    },
  );
  app.post(
    '/api/chats/:chatId/settings/recovery',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        body: z.object({ action: z.enum(['retry', 'discard']) }),
        response: {
          200: z.object({
            effective: settingsSchema,
            pending: settingsOperationSchema.nullable(),
            version: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      const data = await chats.resolveSettings(
        request.params.chatId,
        request.body.action,
        request.headers['if-match'],
      );
      return reply.header('ETag', `"${data.version}"`).send(data);
    },
  );
  app.get(
    '/api/preferences',
    {
      preHandler: protectedRoute,
      schema: { response: { 200: preferencesSchema } },
    },
    async (_request, reply) => {
      const data = chats.preferences();
      return reply.header('ETag', `"${data.version}"`).send(data);
    },
  );
  app.post(
    '/api/chats/:chatId/recovery',
    {
      preHandler: protectedRoute,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        response: { 200: chatSchema },
      },
    },
    async (request, reply) => {
      const chat = await chats.recoverChat(
        request.params.chatId,
        request.headers['if-match'],
      );
      return reply.header('ETag', `"${chat.version}"`).send(chat);
    },
  );
  app.patch(
    '/api/preferences',
    {
      preHandler: protectedRoute,
      schema: {
        body: preferencesSchema.omit({ version: true }),
        response: { 200: preferencesSchema },
      },
    },
    async (request, reply) => {
      const data = await chats.updatePreferences(
        request.body,
        request.headers['if-match'],
      );
      return reply.header('ETag', `"${data.version}"`).send(data);
    },
  );
  app.get(
    '/api/models',
    {
      preHandler: protectedRoute,
      schema: {
        querystring: z.object({ chatId: z.uuid().optional() }),
        response: {
          200: z.object({
            models: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                provider: z.string(),
                available: z.boolean(),
                thinkingLevels: z.array(
                  z.object({ id: z.string(), label: z.string() }),
                ),
                thinkingDefault: z.string(),
                supportsFastMode: z.boolean(),
                fastModeSupport: z
                  .enum(['supported', 'unsupported', 'unknown'])
                  .optional(),
                input: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const chat = request.query.chatId
        ? store.getChat(request.query.chatId)
        : null;
      return {
        models: await gateway.models(
          chat?.agentId && chat.sessionKey
            ? { agentId: chat.agentId, sessionKey: chat.sessionKey }
            : undefined,
        ),
      };
    },
  );
  app.get(
    '/ws/conversation',
    { websocket: true, preHandler: [protectedRoute, consumeConnectionTicket] },
    (socket, request) => {
      if (request.headers.origin !== config.origin) {
        socket.close(1008, 'Origin rejected');
        return;
      }
      const id = sessionId(request);
      const sockets = sessionSockets.get(id) ?? new Set<WebSocket>();
      sockets.add(socket);
      sessionSockets.set(id, sockets);
      function send(frame: unknown): void {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1048576) {
          socket.close(1013, 'Resynchronize');
          return;
        }
        try {
          socket.send(JSON.stringify(parseOutboundFrame(frame)));
        } catch {
          request.log.error(
            { code: 'OUTBOUND_CONTRACT_INVALID' },
            'Outbound conversation frame rejected',
          );
          socket.close(1011, 'Reconnect to refresh');
        }
      }
      const expiry = setTimeout(
        () => socket.close(1008, 'Session expired'),
        Math.max(0, (request.session.get('expiresAt') ?? 0) - Date.now()),
      );
      expiry.unref();
      const unsubscribe = chats.onEvent((event) => {
        if (!store.sessionValid(id)) {
          socket.close(1008, 'Session expired');
          return;
        }
        send(event);
      });
      send({
        type: 'connection.state',
        state: gateway.ready && chats.reconciled ? 'ready' : 'unavailable',
        generation: chats.generation,
        sequence: 0,
      });
      socket.on('message', (raw) => {
        void (async () => {
          if (!store.sessionValid(id)) {
            socket.close(1008, 'Session expired');
            return;
          }
          let command;
          try {
            const bytes = Array.isArray(raw)
              ? Buffer.concat(raw)
              : raw instanceof ArrayBuffer
                ? Buffer.from(raw)
                : raw;
            command = commandSchema.parse(JSON.parse(bytes.toString('utf8')));
          } catch {
            send({
              type: 'command.result',
              commandId: 'invalid',
              ok: false,
              error: toProblem(new ValidationError(), request.id),
            });
            return;
          }
          const result = await chats.command(command);
          send(result);
        })().catch(() => socket.close(1011, 'Connection failed'));
      });
      socket.on('close', () => {
        clearTimeout(expiry);
        unsubscribe();
        sockets.delete(socket);
        if (sockets.size === 0) sessionSockets.delete(id);
      });
    },
  );
  await registerMediaRoutes(app, uploads, store, gateway, protectedRoute);
  const uploadCleanup = setInterval(() => {
    void uploads.cleanup().catch(() => {
      app.log.warn('Temporary upload cleanup failed');
    });
  }, 60000);
  uploadCleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(uploadCleanup);
    for (const sockets of sessionSockets.values())
      for (const socket of sockets) socket.close(1001, 'Server stopping');
    chats.close();
    await gateway.stop();
    store.close();
  });
  gateway.start();
  if (gateway.ready) await chats.reconcile();
  return { app, chats, gateway, store };
}
