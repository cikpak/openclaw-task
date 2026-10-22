import { sha256 } from '../portable/sha256.js';
import { z } from 'zod';
import {
  agentBehaviorEqual,
  agentBehaviorValid,
  CUSTOM_INSTRUCTIONS_LIMIT,
  normalizeAgentBehavior,
  PERSONALITIES,
  RESPONSE_STYLES,
  type AgentBehavior,
} from '@messenger/contracts';
import {
  ConflictError,
  GatewayUnavailableError,
  ValidationError,
} from '../errors.js';
import type { GatewayMapping } from './types.js';
import { withDeliverableInstructions } from './deliverable-instructions.js';

type Request = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;
const START = '<!-- messenger-agent-behavior:v1:begin -->\n';
const END = '\n<!-- messenger-agent-behavior:v1:end -->\n';
const RESERVED = '<!-- messenger-agent-behavior:';
const MAX_FILE_BYTES = 131072;
const fileSchema = z.object({
  agentId: z.string(),
  file: z.object({
    name: z.literal('AGENTS.md'),
    missing: z.boolean(),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    content: z.string().optional(),
    size: z.number().nonnegative().optional(),
  }),
});
const metadataSchema = z
  .object({
    responseStyle: z.enum(RESPONSE_STYLES),
    personality: z.enum(PERSONALITIES),
    customLength: z.number().int().min(0).max(CUSTOM_INSTRUCTIONS_LIMIT),
  })
  .strict();
const styles = {
  default: '',
  concise:
    'Response style: Keep answers concise and direct. Include essential information without unnecessary detail.\n',
  detailed:
    'Response style: Give thorough explanations with useful context and examples when appropriate.\n',
};
const personalities = {
  neutral: '',
  friendly: 'Personality: Use a warm, approachable, conversational tone.\n',
  professional:
    'Personality: Use a polished, professional and respectful tone.\n',
  direct:
    'Personality: Be straightforward and practical, avoiding unnecessary pleasantries.\n',
};
function prefix(
  behavior: AgentBehavior,
  customLength = behavior.customInstructions.length,
): string {
  return `${START}${JSON.stringify({ responseStyle: behavior.responseStyle, personality: behavior.personality, customLength })}\n## Agent behavior\nThese preferences guide responses; they do not grant tool permissions or override security requirements.\n${styles[behavior.responseStyle]}${personalities[behavior.personality]}### Custom instructions\n`;
}
function section(behavior: AgentBehavior): string {
  return prefix(behavior) + behavior.customInstructions + END;
}
function malformed(): never {
  throw new ConflictError(
    'AGENT_INSTRUCTIONS_CONFLICT',
    'The managed agent instructions changed outside Settings. Restore or review the agent settings before trying again.',
  );
}
/** Metadata is length-delimited, so arbitrary user text cannot escape its managed section. */
export function parseAgentInstructions(content: string): {
  behavior: AgentBehavior;
  start: number;
  end: number;
} {
  const start = content.indexOf(START);
  if (start < 0) {
    if (content.includes(RESERVED)) malformed();
    return { behavior: normalizeAgentBehavior({}), start: -1, end: -1 };
  }
  if (start !== 0 && content[start - 1] !== '\n') malformed();
  const metadataEnd = content.indexOf('\n', start + START.length);
  let metadata: z.infer<typeof metadataSchema>;
  try {
    metadata = metadataSchema.parse(
      JSON.parse(content.slice(start + START.length, metadataEnd)),
    );
  } catch {
    malformed();
  }
  const behavior = normalizeAgentBehavior(metadata);
  const customStart = start + prefix(behavior, metadata.customLength).length;
  behavior.customInstructions = content.slice(
    customStart,
    customStart + metadata.customLength,
  );
  const block = section(behavior);
  const end = start + block.length;
  if (
    content.slice(start, end) !== block ||
    content.slice(0, start).includes(RESERVED) ||
    content.slice(end).includes(RESERVED)
  )
    malformed();
  return { behavior, start, end };
}
export class AgentInstructions {
  constructor(private readonly request: Request) {}
  private scope(mapping: GatewayMapping): void {
    if (
      !mapping.agentId ||
      mapping.sessionKey !== `agent:${mapping.agentId}:main`
    )
      throw new ValidationError(
        'Agent instructions require the selected agent’s main session.',
      );
  }
  private async file(mapping: GatewayMapping) {
    this.scope(mapping);
    const result = fileSchema.parse(
      await this.request('agents.files.get', {
        agentId: mapping.agentId,
        name: 'AGENTS.md',
      }),
    );
    if (result.agentId !== mapping.agentId) throw new GatewayUnavailableError();
    const file = result.file;
    if (file.missing) {
      if (file.content || file.hash) throw new GatewayUnavailableError();
      return { content: '', missing: true as const };
    }
    if (
      file.content === undefined ||
      !file.hash ||
      new TextEncoder().encode(file.content).byteLength > MAX_FILE_BYTES ||
      (file.size ?? 0) > MAX_FILE_BYTES ||
      sha256(file.content) !== file.hash.toLowerCase()
    )
      throw new GatewayUnavailableError();
    return { content: file.content, hash: file.hash, missing: false as const };
  }
  async read(mapping: GatewayMapping): Promise<AgentBehavior> {
    return parseAgentInstructions((await this.file(mapping)).content).behavior;
  }
  async ensureDeliverables(mapping: GatewayMapping): Promise<void> {
    const before = await this.file(mapping);
    const content = withDeliverableInstructions(
      before.content,
      parseAgentInstructions(before.content),
    );
    if (content === before.content) return;
    if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES)
      throw new ValidationError(
        'The agent instructions file is too large to update safely.',
      );
    await this.request('agents.files.set', {
      agentId: mapping.agentId,
      name: 'AGENTS.md',
      content,
      ...(before.missing
        ? { expectedMissing: true }
        : { expectedHash: before.hash }),
    });
    if ((await this.file(mapping)).content !== content)
      throw new ConflictError(
        'AGENT_INSTRUCTIONS_UNCONFIRMED',
        'The file-sharing instructions could not be confirmed. Refresh before trying again.',
      );
  }
  async apply(
    mapping: GatewayMapping,
    desired: Partial<AgentBehavior>,
  ): Promise<AgentBehavior> {
    if (!agentBehaviorValid(desired))
      throw new ValidationError('Check the agent behavior settings.');
    const behavior = normalizeAgentBehavior(desired);
    const before = await this.file(mapping);
    const parsed = parseAgentInstructions(before.content);
    if (agentBehaviorEqual(parsed.behavior, behavior)) return parsed.behavior;
    const empty = agentBehaviorEqual(behavior, {});
    const block = empty ? '' : section(behavior);
    const content =
      parsed.start < 0
        ? block + before.content
        : before.content.slice(0, parsed.start) +
          block +
          before.content.slice(parsed.end);
    if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES)
      throw new ValidationError(
        'The agent instructions file is too large to update safely.',
      );
    await this.request('agents.files.set', {
      agentId: mapping.agentId,
      name: 'AGENTS.md',
      content,
      ...(before.missing
        ? { expectedMissing: true }
        : { expectedHash: before.hash }),
    });
    const after = await this.file(mapping);
    if (
      after.content !== content ||
      !agentBehaviorEqual(
        parseAgentInstructions(after.content).behavior,
        behavior,
      )
    )
      throw new ConflictError(
        'AGENT_INSTRUCTIONS_UNCONFIRMED',
        'The agent instructions could not be confirmed. Refresh before trying again.',
      );
    return behavior;
  }
}
