import { z } from 'zod';
import type { ManagerCommand } from '@messenger/contracts';
import { UPLOAD_CHUNK_BYTES, UPLOAD_FILE_BYTES } from '@messenger/contracts';
import {
  commandSchema,
  createChatSchema,
  preferencesSchema,
  settingsSchema,
} from '../schemas.js';

const base = { commandId: z.uuid() };
const chat = { ...base, chatId: z.uuid() };
const version = z.number().int().positive();
const versionedChat = { ...chat, version };
const fileId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const applicationCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('application.bootstrap.request') }),
  z.object({ ...base, type: z.literal('chat.list') }),
  createChatSchema.extend({ type: z.literal('chat.create') }),
  z.object({ ...chat, type: z.literal('chat.get') }),
  z.object({
    ...versionedChat,
    type: z.literal('chat.rename'),
    name: z.string().trim().min(1).max(100),
  }),
  z.object({ ...versionedChat, type: z.literal('chat.delete') }),
  z.object({ ...versionedChat, type: z.literal('chat.recover') }),
  z.object({ ...chat, type: z.literal('chat.settings.get') }),
  z.object({
    ...versionedChat,
    type: z.literal('chat.settings.update'),
    settings: settingsSchema,
    policy: z.enum(['when-idle', 'cancel-work']),
  }),
  z.object({
    ...versionedChat,
    type: z.literal('chat.settings.resolve'),
    action: z.enum(['retry', 'discard']),
  }),
  z.object({ ...base, type: z.literal('preferences.get') }),
  z.object({
    ...base,
    type: z.literal('preferences.update'),
    version,
    preferences: preferencesSchema.omit({ version: true }),
  }),
  z.object({
    ...base,
    type: z.literal('models.list'),
    cachedOnly: z.boolean().optional(),
    chatId: z.uuid().optional(),
  }),
  z.object({
    ...chat,
    type: z.literal('files.list'),
    category: z.enum(['shared', 'generated', 'all']),
  }),
  z.object({ ...chat, type: z.literal('files.resolve'), fileId }),
  z.object({
    ...base,
    type: z.literal('upload.begin'),
    name: z
      .string()
      .min(1)
      .max(300)
      .refine(
        (name) =>
          !/[/\\]/u.test(name) &&
          Array.from(name).every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
      ),
    mimeType: z.enum([
      'image/png',
      'image/jpeg',
      'image/webp',
      'text/plain',
      'text/markdown',
      'application/pdf',
    ]),
    size: z.number().int().positive().max(UPLOAD_FILE_BYTES),
  }),
  z.object({
    ...base,
    type: z.literal('upload.chunk'),
    uploadId: z.uuid(),
    offset: z.number().int().nonnegative().max(UPLOAD_FILE_BYTES),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      ),
  }),
  z.object({ ...base, type: z.literal('upload.complete'), uploadId: z.uuid() }),
  z.object({ ...base, type: z.literal('upload.remove'), uploadId: z.uuid() }),
  z.object({
    ...chat,
    type: z.literal('conversation.recent.request'),
    viewport: z.object({
      width: z.number().positive().max(16384),
      height: z.number().positive().max(16384),
      fontSize: z.number().min(8).max(96),
      lineHeight: z.number().min(8).max(192),
    }),
  }),
  z.object({
    ...base,
    type: z.literal('command.receipt.request'),
    receiptCommandId: z.uuid(),
  }),
]);

/** Parse structured data only; WebSocket framing enforces the byte limit first. */
export const managerCommandSchema: z.ZodType<ManagerCommand> = z.union([
  commandSchema,
  applicationCommandSchema,
]);
