import { z } from 'zod';
import { preferencesSchema } from '../schemas.js';
import type { LegacyContext } from './context.js';

export function registerPreferences(context: LegacyContext) {
  const { app, store, chats, gateway, protectedRoute } = context;
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
}
