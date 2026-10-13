import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store } from '../database.js';
import type { Gateway } from '../gateway/types.js';
import {
  ApplicationError,
  GatewayUnavailableError,
  ValidationError,
  NotFoundError,
} from '../errors.js';
import { FILE_LIMIT } from './validation.js';
import type { UploadService } from './service.js';
import { sharedFiles } from './shared-files.js';
import {
  artifactCatalogResponseSchema,
  sharedFilesResponseSchema,
  downloadResponseHeadersSchema,
  mediaArtifactSchema,
  mediaErrorResponses,
  noContentSchema,
  uploadResponseHeadersSchema,
  uploadResponseSchema,
  validateMediaResponse,
} from './schemas.js';

export async function registerMediaRoutes(
  app: FastifyInstance,
  uploads: UploadService,
  store: Store,
  gateway: Gateway,
  authorize: (request: FastifyRequest) => Promise<void>,
): Promise<void> {
  await app.register(multipart, {
    limits: { fileSize: FILE_LIMIT, files: 1, fields: 0, parts: 1 },
  });
  app.post(
    '/api/uploads',
    {
      preHandler: authorize,
      bodyLimit: FILE_LIMIT + 65536,
      schema: {
        response: { 201: uploadResponseSchema, ...mediaErrorResponses },
      },
    },
    async (request, reply) => {
      try {
        const parts = request.parts();
        let file: { bytes: Buffer; mime: string; name: string } | null = null;
        for await (const part of parts) {
          if (part.type !== 'file' || part.fieldname !== 'file' || file)
            throw new ValidationError('Upload exactly one file.');
          file = {
            bytes: await part.toBuffer(),
            mime: part.mimetype,
            name: part.filename,
          };
          if (part.file.truncated)
            throw new ApplicationError(
              413,
              'UPLOAD_TOO_LARGE',
              'Each attachment must be at most five MiB.',
            );
        }
        if (!file) throw new ValidationError('Select a file to upload.');
        const item = validateMediaResponse(
          uploadResponseSchema,
          await uploads.create(file.bytes, file.mime, file.name),
        );
        const headers = validateMediaResponse(uploadResponseHeadersSchema, {
          location: `/api/uploads/${item.uploadId}`,
        });
        return reply.code(201).headers(headers).send(item);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code.startsWith('FST_')
        )
          throw new ApplicationError(
            413,
            'UPLOAD_LIMIT',
            'Upload one file of at most five MiB.',
          );
        throw error;
      }
    },
  );
  app.delete(
    '/api/uploads/:uploadId',
    {
      preHandler: authorize,
      schema: {
        params: z.object({ uploadId: z.uuid() }),
        response: { 204: noContentSchema, ...mediaErrorResponses },
      },
    },
    async (request, reply) => {
      const { uploadId } = z
        .object({ uploadId: z.uuid() })
        .parse(request.params);
      validateMediaResponse(noContentSchema, await uploads.remove(uploadId));
      return reply.code(204).send();
    },
  );
  app.get(
    '/api/chats/:chatId/shared-files',
    {
      preHandler: authorize,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        response: { 200: sharedFilesResponseSchema, ...mediaErrorResponses },
      },
    },
    async (request, reply) => {
      const { chatId } = z.object({ chatId: z.uuid() }).parse(request.params);
      const files = await sharedFiles(
        store,
        gateway,
        uploads.accountOwner(),
        chatId,
      );
      reply.header('Cache-Control', 'private, no-store');
      return validateMediaResponse(sharedFilesResponseSchema, { files });
    },
  );
  app.get(
    '/api/chats/:chatId/artifacts',
    {
      preHandler: authorize,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        response: {
          200: artifactCatalogResponseSchema,
          ...mediaErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { chatId } = z.object({ chatId: z.uuid() }).parse(request.params);
      const chat = store.getChat(chatId);
      if (!gateway.artifacts || !chat.agentId || !chat.sessionKey)
        throw new GatewayUnavailableError();
      reply.header('Cache-Control', 'private, no-store');
      return validateMediaResponse(artifactCatalogResponseSchema, {
        artifacts: await gateway.artifacts({
          agentId: chat.agentId,
          sessionKey: chat.sessionKey,
        }),
      });
    },
  );
  app.get(
    '/api/chats/:chatId/artifacts/resolve',
    {
      preHandler: authorize,
      schema: {
        params: z.object({ chatId: z.uuid() }),
        querystring: z.object({ path: z.string().min(1).max(2048) }),
        response: {
          200: z.object({ artifact: mediaArtifactSchema }),
          ...mediaErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { chatId } = z.object({ chatId: z.uuid() }).parse(request.params);
      const { path } = z
        .object({ path: z.string().min(1).max(2048) })
        .parse(request.query);
      const chat = store.getChat(chatId);
      if (
        chat.status === 'deleting' ||
        !gateway.resolveArtifact ||
        !chat.agentId ||
        !chat.sessionKey
      )
        throw new NotFoundError();
      const artifact = await gateway.resolveArtifact(
        { agentId: chat.agentId, sessionKey: chat.sessionKey },
        path,
      );
      if (store.getChat(chatId).status === 'deleting')
        throw new NotFoundError();
      reply.header('Cache-Control', 'private, no-store');
      return validateMediaResponse(
        z.object({ artifact: mediaArtifactSchema }),
        { artifact },
      );
    },
  );
  app.get(
    '/api/chats/:chatId/artifacts/:artifactId',
    {
      preHandler: authorize,
      schema: {
        params: z.object({
          chatId: z.uuid(),
          artifactId: z
            .string()
            .min(1)
            .max(2732)
            .regex(/^[A-Za-z0-9_-]+$/),
        }),
        // Buffer replies bypass JSON serialization. Forbid accidental JSON at 200;
        // the handler validates binary bounds, metadata, and headers explicitly.
        response: { 200: z.never(), ...mediaErrorResponses },
      },
    },
    async (request, reply) => {
      const { chatId, artifactId } = z
        .object({ chatId: z.uuid(), artifactId: z.string().max(2732) })
        .parse(request.params);
      const chat = store.getChat(chatId);
      if (chat.status === 'deleting') throw new NotFoundError();
      if (!gateway.artifact || !chat.agentId || !chat.sessionKey)
        throw new GatewayUnavailableError();
      const result = await gateway.artifact(
        { agentId: chat.agentId, sessionKey: chat.sessionKey },
        artifactId,
      );
      if (store.getChat(chatId).status === 'deleting')
        throw new NotFoundError();
      const artifact = validateMediaResponse(
        mediaArtifactSchema,
        result.artifact,
      );
      if (
        !Buffer.isBuffer(result.bytes) ||
        result.bytes.length > FILE_LIMIT ||
        result.bytes.length !== artifact.sizeBytes ||
        artifact.id !== artifactId
      )
        throw new Error('Invalid artifact byte response.');
      const headers = validateMediaResponse(downloadResponseHeadersSchema, {
        'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Type': 'application/octet-stream',
        'Content-Length': result.bytes.length,
      });
      return reply.headers(headers).send(result.bytes);
    },
  );
}
