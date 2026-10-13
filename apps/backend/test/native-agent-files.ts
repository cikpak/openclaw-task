import { createHash } from 'node:crypto';
import { z } from 'zod';

const scope = z.object({
  agentId: z.string().min(1),
  name: z.literal('AGENTS.md'),
});
const hash = (content: string) =>
  createHash('sha256').update(content).digest('hex');

/** Stateful native-file double: selected-agent scope, conditional writes and readback. */
export function nativeAgentFileRequest(
  files: Map<string, string>,
  method: string,
  raw: unknown,
): unknown {
  const { agentId, name } = scope.parse(raw);
  const current = files.get(agentId);
  if (method === 'agents.files.get')
    return {
      agentId,
      file:
        current === undefined
          ? { name, missing: true }
          : {
              name,
              missing: false,
              content: current,
              size: Buffer.byteLength(current),
              hash: hash(current),
            },
    };
  if (method === 'agents.files.set') {
    const params = scope
      .extend({
        content: z.string(),
        expectedMissing: z.literal(true).optional(),
        expectedHash: z.string().optional(),
      })
      .parse(raw);
    if (
      current === undefined
        ? params.expectedMissing !== true || params.expectedHash !== undefined
        : params.expectedMissing !== undefined ||
          params.expectedHash !== hash(current)
    )
      throw new Error('Native instruction file changed before write');
    files.set(agentId, params.content);
    return { ok: true };
  }
  throw new Error(`Unexpected native file RPC: ${method}`);
}
