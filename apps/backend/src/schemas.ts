import { z } from 'zod';
import {
  type ChatSettings,
  CUSTOM_INSTRUCTIONS_LIMIT,
  PERSONALITIES,
  RESPONSE_STYLES,
} from '@messenger/contracts';
import { projectToolText } from './gateway/tools.js';
export const settingsSchema: z.ZodType<ChatSettings> = z.object({
  model: z.string().min(1).max(256),
  thinkingLevel: z.string().min(1).max(32),
  fastMode: z.boolean(),
  customInstructions: z.string().max(CUSTOM_INSTRUCTIONS_LIMIT).default(''),
  responseStyle: z.enum(RESPONSE_STYLES).default('default'),
  personality: z.enum(PERSONALITIES).default('neutral'),
});
export const attachmentSchema = z.object({
  uploadId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});
export const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'tool']),
    text: z.string(),
    createdAt: z.number(),
    runId: z.string().optional(),
    toolCallId: z.string().min(1).max(256).optional(),
    toolName: z.enum(['read', 'write', 'edit', 'web_fetch']).optional(),
    historySequence: z.number().int().nonnegative().optional(),
    requestFailed: z.boolean().optional(),
    attachments: z.array(attachmentSchema).optional(),
    artifacts: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  })
  .transform((message) =>
    message.role === 'tool'
      ? { ...message, text: projectToolText(message.text) }
      : message,
  );
export const chatSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['creating', 'idle', 'running', 'deleting', 'recovery']),
  version: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  unread: z.boolean(),
  settings: settingsSchema,
});
export const pendingSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  position: z.number(),
  text: z.string(),
  attachments: z.array(attachmentSchema),
  revision: z.number(),
  state: z.enum(['pending', 'submitting', 'submitted', 'unknown', 'cancelled']),
  submissionId: z.string(),
  createdAt: z.number(),
});
export const settingsOperationSchema = z.object({
  id: z.string(),
  settings: settingsSchema,
  policy: z.enum(['when-idle', 'cancel-work']),
  status: z.enum(['pending', 'applying', 'unknown', 'failed']),
});
export const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  parameters: z.string().max(4096),
  output: z.string().max(8192),
});
export const snapshotSchema = z.object({
  chat: chatSchema,
  messages: z.array(messageSchema),
  pending: z.array(pendingSchema).max(41),
  hiddenPendingCount: z.number().int().nonnegative().optional(),
  activeRun: z
    .object({
      id: z.string(),
      text: z.string().max(256 * 1024),
      sequence: z.number(),
      truncated: z.boolean().optional(),
    })
    .nullable(),
  pendingSettings: settingsOperationSchema.nullable(),
  settledRun: z
    .object({
      id: z.string(),
      text: z.string().max(256 * 1024),
      sequence: z.number().int().nonnegative(),
      truncated: z.boolean().optional(),
      state: z.enum(['final', 'error', 'aborted']),
    })
    .optional(),
  hasOlderHistory: z.boolean(),
  historyCursor: z.string().nullable(),
  tools: z.array(toolSchema).max(100).optional(),
});
const eventOrder = {
  generation: z.string().min(1),
  sequence: z.number().int().nonnegative(),
};
export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('connection.state'),
    ...eventOrder,
    state: z.enum(['ready', 'unavailable']),
  }),
  z.object({
    type: z.literal('conversation.snapshot'),
    ...eventOrder,
    snapshot: snapshotSchema,
  }),
  z.object({
    type: z.literal('conversation.updated'),
    ...eventOrder,
    chat: chatSchema,
  }),
  z.object({
    type: z.literal('conversation.deleted'),
    ...eventOrder,
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal('conversation.run.text'),
    ...eventOrder,
    chatId: z.string().min(1),
    runId: z.string().min(1),
    text: z.string().max(256 * 1024),
    replace: z.boolean(),
    runSequence: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('conversation.tool'),
    ...eventOrder,
    chatId: z.string().min(1),
    tool: toolSchema,
  }),
]);
export const preferencesSchema = z.object({
  version: z.number().int(),
  busySendBehavior: z.enum(['queue', 'steer']),
  defaults: settingsSchema,
});
export const createChatSchema = z.object({
  commandId: z.uuid(),
  name: z.string().trim().min(1).max(100).optional(),
  settings: settingsSchema,
  initialMessage: z
    .object({
      text: z.string().max(32000),
      uploadIds: z.array(z.uuid()).max(5).optional(),
    })
    .optional(),
});
const base = { commandId: z.uuid(), chatId: z.uuid() };
const queued = {
  ...base,
  messageId: z.uuid(),
  revision: z.number().int().positive(),
};
export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation.message.send'),
    ...base,
    text: z.string().max(32000),
    uploadIds: z.array(z.uuid()).max(5).optional(),
    behavior: z.enum(['queue', 'steer']).optional(),
  }),
  z.object({
    type: z.literal('conversation.message.editQueued'),
    ...queued,
    text: z.string().max(32000),
    uploadIds: z.array(z.uuid()).max(5).optional(),
  }),
  z.object({ type: z.literal('conversation.message.cancelQueued'), ...queued }),
  z.object({ type: z.literal('conversation.message.steerQueued'), ...queued }),
  z.object({ type: z.literal('conversation.run.abort'), ...base }),
  z.object({
    type: z.literal('conversation.message.resolveUnknown'),
    ...queued,
    action: z.enum(['discard', 'retry']),
  }),
  z.object({
    type: z.literal('conversation.snapshot.request'),
    commandId: z.uuid(),
    chatId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal('conversation.history.request'),
    ...base,
    cursor: z.string().max(512).optional(),
  }),
  z.object({ type: z.literal('conversation.message.read'), ...base }),
]);
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  code: z.string(),
  correlationId: z.string(),
});
export const resultSchema = z.discriminatedUnion('ok', [
  z.object({
    type: z.literal('command.result'),
    commandId: z.string(),
    ok: z.literal(true),
    data: z.object({
      messageId: z.string().optional(),
      snapshot: snapshotSchema.optional(),
      snapshots: z.array(snapshotSchema).optional(),
      messages: z.array(messageSchema).optional(),
      historyCursor: z.string().nullable().optional(),
      hasOlderHistory: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal('command.result'),
    commandId: z.string(),
    ok: z.literal(false),
    error: problemSchema,
  }),
]);
export const outboundFrameSchema = z.union([eventSchema, resultSchema]);
