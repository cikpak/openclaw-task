/* eslint-disable @typescript-eslint/require-await */
import { z } from 'zod';
import { summary } from '../chats/service.js';
import {
  chatSchema,
  createChatSchema,
  settingsSchema,
  settingsOperationSchema,
} from '../schemas.js';
import type { LegacyContext } from './context.js';

export function registerChats(context: LegacyContext) {
  const { app, store, chats, protectedRoute } = context;
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
}
