export const CUSTOM_INSTRUCTIONS_LIMIT = 8000;
export const RESPONSE_STYLES = ['default', 'concise', 'detailed'] as const;
export const PERSONALITIES = [
  'neutral',
  'friendly',
  'professional',
  'direct',
] as const;
export interface AgentBehavior {
  customInstructions: string;
  responseStyle: (typeof RESPONSE_STYLES)[number];
  personality: (typeof PERSONALITIES)[number];
}
export const DEFAULT_AGENT_BEHAVIOR: Readonly<AgentBehavior> = {
  customInstructions: '',
  responseStyle: 'default',
  personality: 'neutral',
};
export function normalizeAgentBehavior(
  value: Partial<AgentBehavior>,
): AgentBehavior {
  return {
    customInstructions: value.customInstructions ?? '',
    responseStyle: value.responseStyle ?? 'default',
    personality: value.personality ?? 'neutral',
  };
}
export function agentBehaviorEqual(
  left: Partial<AgentBehavior>,
  right: Partial<AgentBehavior>,
): boolean {
  const a = normalizeAgentBehavior(left);
  const b = normalizeAgentBehavior(right);
  return (
    a.customInstructions === b.customInstructions &&
    a.responseStyle === b.responseStyle &&
    a.personality === b.personality
  );
}
export function agentBehaviorValid(value: {
  customInstructions?: unknown;
  responseStyle?: unknown;
  personality?: unknown;
}): boolean {
  return (
    (value.customInstructions === undefined ||
      (typeof value.customInstructions === 'string' &&
        value.customInstructions.length <= CUSTOM_INSTRUCTIONS_LIMIT)) &&
    (value.responseStyle === undefined ||
      RESPONSE_STYLES.some((style) => style === value.responseStyle)) &&
    (value.personality === undefined ||
      PERSONALITIES.some((personality) => personality === value.personality))
  );
}
