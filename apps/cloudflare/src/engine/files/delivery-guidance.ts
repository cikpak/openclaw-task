/** Per-turn context: native Codex bindings intentionally freeze their AGENTS.md snapshot. */
export const DELIVERY_GUIDANCE = `File sharing for this request:
When the user asks you to create or download a file, actually use an available native write/edit tool to save the user-facing deliverable as documents/<safe-filename> inside this agent's workspace. Files at the workspace root are private and cannot appear in the conversation's Files panel.
Use only tools actually exposed for this turn, such as openclaw_direct.write or openclaw_direct.edit if available. Do not invent apply_patch, exec, or a terminal. Claim a file is created or downloadable only after the native tool succeeds.
After success, link the deliverable using its workspace-relative documents/<safe-filename> path. Never link private root paths, credentials, internal files, or another agent's files.
For download requests, use an available web_fetch tool. If it returns complete text, faithfully save that text with write. If available tools cannot retrieve complete original bytes (including binary files), explain the limitation. Do not fabricate a successful download or invent substitute content.`;
