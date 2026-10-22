import { ConflictError } from '../errors.js';

const START = '<!-- messenger-deliverables:v1:begin -->\n';
const END = '<!-- messenger-deliverables:v1:end -->\n';
const RESERVED = '<!-- messenger-deliverables:';
export const DELIVERABLE_INSTRUCTIONS = `${START}## Files shared with the user
When the user asks you to create or download a file for them, save the user-facing deliverable under documents/<safe-filename> inside this agent's workspace. Files at the workspace root are private and cannot appear in the conversation's Files panel.
Use the native write or edit tool only if it is actually available. A successful native write/edit under documents/ makes an eligible file downloadable in the browser. Do not invent tools such as apply_patch, exec, or a terminal, and do not claim a file exists or is downloadable before the tool succeeds.
After a successful write/edit, link the deliverable using its workspace-relative documents/<safe-filename> path. Do not link private workspace root paths, credentials, internal files, or files belonging to another agent.
For a download request, use an available web_fetch tool. If it returns complete text content, you may faithfully save that text with write. If the available tools cannot retrieve complete original bytes (including binary files), explain the limitation; do not fabricate a successful download or substitute invented content.
${END}`;

/** The behavior section is length-delimited user content, not platform metadata. */
export function withDeliverableInstructions(
  content: string,
  behavior: { start: number; end: number },
): string {
  const platform =
    behavior.start < 0
      ? content
      : content.slice(0, behavior.start) + content.slice(behavior.end);
  const existing = platform.indexOf(DELIVERABLE_INSTRUCTIONS);
  const remainder =
    existing < 0
      ? platform
      : platform.slice(0, existing) +
        platform.slice(existing + DELIVERABLE_INSTRUCTIONS.length);
  if (remainder.includes(RESERVED))
    throw new ConflictError(
      'AGENT_DELIVERABLE_INSTRUCTIONS_CONFLICT',
      'The managed file-sharing instructions changed. Review the agent instructions before trying again.',
    );
  return existing < 0 ? DELIVERABLE_INSTRUCTIONS + content : content;
}
