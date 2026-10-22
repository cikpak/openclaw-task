import { z } from 'zod';
import type { GatewayContext } from './context.js';
import type { GatewayMapping, GatewayAttachment } from './types.js';
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
  async abort(mapping: GatewayMapping): Promise<void> {
    await this.context.request('sessions.abort', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
      clearQueued: true,
    });
  }
}
