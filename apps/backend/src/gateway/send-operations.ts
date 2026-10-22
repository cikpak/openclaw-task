import { z } from 'zod';
import type { GatewayContext } from './context.js';
import type {
  GatewayMapping,
  GatewayAttachment,
  NativeInputCancellation,
} from './types.js';
import { ApplicationError } from '../errors.js';
export class SendOperations {
  constructor(private readonly context: GatewayContext) {}
  async send(
    mapping: GatewayMapping,
    submissionId: string,
    text: string,
    behavior: 'queue' | 'steer',
    attachments: GatewayAttachment[] = [],
  ): Promise<{ runId: string; status: string }> {
    const params = {
      sessionKey: mapping.sessionKey,
      agentId: mapping.agentId,
      message: text,
      idempotencyKey: submissionId,
      queueMode: behavior === 'steer' ? 'steer' : 'followup',
      ...(attachments.length ? { attachments } : {}),
    };
    if (
      Buffer.byteLength(JSON.stringify(params)) + 1024 >
      this.context.transport.maxPayload
    )
      throw new ApplicationError(
        413,
        'GATEWAY_PAYLOAD_LIMIT',
        'This message exceeds the current OpenClaw transfer limit.',
      );
    return z
      .object({ runId: z.string(), status: z.string() })
      .parse(await this.context.request('chat.send', params));
  }
  async abortChat(
    mapping: GatewayMapping,
  ): Promise<void | { runIds: string[]; inputs: NativeInputCancellation[] }> {
    const exact = z
      .string()
      .min(1)
      .refine((id) => id === id.trim());
    const raw = await this.context.request('chat.abort', {
      sessionKey: mapping.sessionKey,
      agentId: mapping.agentId,
    });
    if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'warning')) return;
    const parsed = z
      .object({
        ok: z.literal(true),
        aborted: z.literal(true),
        runIds: z.array(exact).nonempty(),
        preExecutionInputCancellations: z
          .array(
            z.object({
              kind: z.literal('pre-execution-input-cancelled'),
              inputId: exact,
              sessionId: exact,
              sessionKey: exact,
              agentId: exact,
            }),
          )
          .optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return;
    const { runIds, preExecutionInputCancellations: inputs = [] } = parsed.data;
    if (
      new Set(runIds).size !== runIds.length ||
      new Set(inputs.map((input) => input.inputId)).size !== inputs.length ||
      inputs.some(
        (input) =>
          !runIds.includes(input.inputId) ||
          input.agentId !== mapping.agentId ||
          input.sessionKey !== mapping.sessionKey,
      )
    )
      return;
    return { runIds, inputs };
  }
  async abort(
    mapping: GatewayMapping,
    runId?: string,
  ): Promise<void | { abortedRunId: string }> {
    if (runId !== undefined && (!runId || runId !== runId.trim()))
      throw new Error('Invalid native cancellation owner');
    const result = z
      .object({
        ok: z.literal(true),
        status: z.enum(['aborted', 'no-active-run']),
        abortedRunId: z
          .string()
          .min(1)
          .refine((id) => id === id.trim())
          .nullable(),
        warning: z.string().optional(),
      })
      .safeParse(
        await this.context.request('sessions.abort', {
          key: mapping.sessionKey,
          agentId: mapping.agentId,
          ...(runId !== undefined ? { runId } : { clearQueued: true }),
        }),
      );
    // The native ACK follows terminal persistence. Empty, partial or generic
    // success responses cannot establish which accepted work was cancelled.
    if (
      result.success &&
      result.data.status === 'aborted' &&
      result.data.abortedRunId &&
      !result.data.warning &&
      (runId === undefined || result.data.abortedRunId === runId)
    )
      return { abortedRunId: result.data.abortedRunId };
  }
}
