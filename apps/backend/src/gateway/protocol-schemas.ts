import { z } from 'zod';
export const modelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  available: z.boolean().optional(),
  manualSelectionAllowed: z.boolean().optional(),
  thinkingLevels: z
    .array(z.object({ id: z.string(), label: z.string() }))
    .optional(),
  thinkingDefault: z.string().optional(),
  supportsFastMode: z.boolean().optional(),
  input: z.array(z.string()).optional(),
});
export const modelResultSchema = z.object({ models: z.array(modelSchema) });
export const agentsResultSchema = z.object({
  agents: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
export const upstreamMessageSchema = z
  .object({
    id: z.string().optional(),
    messageId: z.string().optional(),
    __openclaw: z
      .object({
        id: z.string().optional(),
        idempotencyKey: z.string().optional(),
        steerTargetRunId: z.string().optional(),
        messengerProcessing: z
          .object({
            runId: z
              .string()
              .min(1)
              .refine((value) => value === value.trim()),
            keys: z
              .array(
                z
                  .string()
                  .min(1)
                  .refine((value) => value === value.trim()),
              )
              .nonempty(),
          })
          .optional(),
        truncated: z.boolean().optional(),
        runId: z.string().min(1).optional(),
        seq: z.number().int().nonnegative().optional(),
        recordTimestampMs: z.number().optional(),
      })
      .optional(),
    role: z.string().optional(),
    runId: z.string().min(1).optional(),
    idempotencyKey: z.string().optional(),
    toolCallId: z.string().min(1).max(256).optional(),
    toolName: z.string().max(100).optional(),
    content: z
      .union([
        z.string(),
        z.array(
          z
            .object({ type: z.string(), text: z.string().optional() })
            .passthrough(),
        ),
      ])
      .optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();
export const chatEventSchema = z.object({
  sessionKey: z.string(),
  runId: z.string(),
  seq: z.number().int(),
  state: z.enum(['delta', 'final', 'aborted', 'error', 'status']),
  deltaText: z.string().optional(),
  message: z.unknown().optional(),
  replace: z.boolean().optional(),
});
export const settingsEntrySchema = z
  .object({
    sessionId: z.string().optional(),
    model: z.string().optional(),
    modelProvider: z.string().optional(),
    thinkingLevel: z.string().optional(),
    fastMode: z.union([z.boolean(), z.string()]).optional(),
  })
  .passthrough();
export const patchResultSchema = z.object({
  ok: z.literal(true),
  entry: settingsEntrySchema,
  resolved: z.object({
    model: z.string(),
    modelProvider: z.string(),
    thinkingLevel: z.string().optional(),
  }),
});
const receiptSchema = z.object({
  runId: z.string(),
  state: z.enum(['pending', 'consumed']),
  cancelled: z.boolean().optional(),
  consumedByEventId: z.string().optional(),
});
export const historySchema = z
  .object({
    sessionKey: z.string().optional(),
    sessionId: z.string().optional(),
    messages: z.array(z.unknown()),
    sessionInfo: settingsEntrySchema.optional(),
    thinkingLevel: z.string().optional(),
    fastMode: z.union([z.boolean(), z.string()]).optional(),
    inFlightRun: z
      .object({
        runId: z.string(),
        text: z.string().optional(),
        seq: z.number().optional(),
        message: z.unknown().optional(),
        events: z.array(z.unknown()).max(1000).optional(),
      })
      .passthrough()
      .optional(),
    deltaCursor: z.string().optional(),
    hasMore: z.boolean().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
    totalMessages: z.number().int().nonnegative().optional(),
    inputReceipts: z.array(receiptSchema).optional(),
  })
  .passthrough();
