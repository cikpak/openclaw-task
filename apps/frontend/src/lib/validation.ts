import type {
  Attachment,
  Artifact,
  ChatSettings,
  ChatSnapshot,
  ChatSummary,
  ConversationFrame,
  Message,
  ModelCapability,
  PendingMessage,
  Preferences,
  SettingsOperation,
  ToolActivity,
} from '@messenger/contracts';
import { agentBehaviorValid } from './agent-behavior';

export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const timestamp = (value: unknown): value is number =>
  number(value) && value >= 0 && value <= 8640000000000000;
const integer = (value: unknown): value is number =>
  number(value) && Number.isSafeInteger(value) && value >= 0;
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const oneOf = (value: unknown, options: string[]) =>
  string(value) && options.includes(value);
const arrayOf = <T>(
  value: unknown,
  check: (v: unknown) => v is T,
): value is T[] => Array.isArray(value) && value.every(check);
export const settingsValid = (v: unknown): v is ChatSettings =>
  record(v) &&
  string(v.model) &&
  string(v.thinkingLevel) &&
  bool(v.fastMode) &&
  agentBehaviorValid(v);
export const attachmentValid = (v: unknown): v is Attachment =>
  record(v) &&
  string(v.uploadId) &&
  string(v.name) &&
  string(v.mimeType) &&
  number(v.size) &&
  v.size >= 0;
export const artifactValid = (v: unknown): v is Artifact =>
  record(v) &&
  string(v.id) &&
  string(v.name) &&
  string(v.mimeType) &&
  number(v.sizeBytes) &&
  v.sizeBytes >= 0 &&
  (v.sourcePath === undefined ||
    (string(v.sourcePath) &&
      v.sourcePath.length > 0 &&
      v.sourcePath.length <= 2048 &&
      !v.sourcePath.startsWith('/') &&
      !v.sourcePath.includes('\\') &&
      !Array.from(v.sourcePath).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) &&
      v.sourcePath
        .split('/')
        .every((part) => part.length > 0 && !part.startsWith('.'))));
export const chatValid = (v: unknown): v is ChatSummary =>
  record(v) &&
  string(v.id) &&
  string(v.name) &&
  oneOf(v.status, ['creating', 'idle', 'running', 'deleting', 'recovery']) &&
  number(v.version) &&
  timestamp(v.createdAt) &&
  timestamp(v.updatedAt) &&
  bool(v.unread) &&
  settingsValid(v.settings);
export const messageValid = (v: unknown): v is Message =>
  record(v) &&
  string(v.id) &&
  oneOf(v.role, ['user', 'assistant', 'tool']) &&
  string(v.text) &&
  timestamp(v.createdAt) &&
  (v.runId === undefined || string(v.runId)) &&
  (v.historySequence === undefined || integer(v.historySequence)) &&
  (v.requestFailed === undefined || bool(v.requestFailed)) &&
  (v.toolCallId === undefined ||
    (string(v.toolCallId) &&
      v.toolCallId.length > 0 &&
      v.toolCallId.length <= 256)) &&
  (v.toolName === undefined ||
    oneOf(v.toolName, ['read', 'write', 'edit', 'web_fetch'])) &&
  (v.attachments === undefined || arrayOf(v.attachments, attachmentValid)) &&
  (v.artifacts === undefined || arrayOf(v.artifacts, artifactValid));
const pendingValid = (v: unknown): v is PendingMessage =>
  record(v) &&
  string(v.id) &&
  string(v.chatId) &&
  integer(v.position) &&
  string(v.text) &&
  arrayOf(v.attachments, attachmentValid) &&
  v.text.length <= 32000 &&
  integer(v.revision) &&
  v.revision > 0 &&
  oneOf(v.state, [
    'pending',
    'submitting',
    'submitted',
    'unknown',
    'cancelled',
  ]) &&
  string(v.submissionId) &&
  timestamp(v.createdAt);
const operationValid = (v: unknown): v is SettingsOperation =>
  record(v) &&
  string(v.id) &&
  settingsValid(v.settings) &&
  oneOf(v.policy, ['when-idle', 'cancel-work']) &&
  oneOf(v.status, ['pending', 'applying', 'unknown', 'failed']);
export const snapshotValid = (v: unknown): v is ChatSnapshot => {
  if (!record(v) || !chatValid(v.chat) || !arrayOf(v.pending, pendingValid))
    return false;
  if (v.pending.length > 41) return false;
  const chatId = v.chat.id;
  return (
    arrayOf(v.messages, messageValid) &&
    v.pending.every((p) => p.chatId === chatId) &&
    (v.activeRun === null ||
      (record(v.activeRun) &&
        string(v.activeRun.id) &&
        string(v.activeRun.text) &&
        v.activeRun.text.length <= 256 * 1024 &&
        integer(v.activeRun.sequence) &&
        (v.activeRun.truncated === undefined ||
          bool(v.activeRun.truncated)))) &&
    (v.pendingSettings === null || operationValid(v.pendingSettings)) &&
    (v.settledRun === undefined ||
      (v.activeRun === null &&
        record(v.settledRun) &&
        string(v.settledRun.id) &&
        v.settledRun.id.length > 0 &&
        string(v.settledRun.text) &&
        v.settledRun.text.length > 0 &&
        v.settledRun.text.length <= 256 * 1024 &&
        integer(v.settledRun.sequence) &&
        (v.settledRun.truncated === undefined ||
          bool(v.settledRun.truncated)) &&
        oneOf(v.settledRun.state, ['final', 'error', 'aborted']))) &&
    bool(v.hasOlderHistory) &&
    (v.historyCursor === null || string(v.historyCursor)) &&
    (v.tools === undefined ||
      (arrayOf(v.tools, toolValid) && v.tools.length <= 100)) &&
    (v.hiddenPendingCount === undefined || integer(v.hiddenPendingCount))
  );
};
const toolValid = (v: unknown): v is ToolActivity =>
  record(v) &&
  string(v.id) &&
  string(v.name) &&
  v.id.length <= 513 &&
  v.name.length <= 100 &&
  oneOf(v.status, ['running', 'completed', 'failed']) &&
  string(v.parameters) &&
  string(v.output) &&
  v.parameters.length <= 4096 &&
  v.output.length <= 8192;
export const modelValid = (v: unknown): v is ModelCapability =>
  record(v) &&
  string(v.id) &&
  string(v.name) &&
  string(v.provider) &&
  bool(v.available) &&
  Array.isArray(v.thinkingLevels) &&
  v.thinkingLevels.every(
    (level) => record(level) && string(level.id) && string(level.label),
  ) &&
  string(v.thinkingDefault) &&
  bool(v.supportsFastMode) &&
  (v.fastModeSupport === undefined ||
    (oneOf(v.fastModeSupport, ['supported', 'unsupported', 'unknown']) &&
      (v.fastModeSupport === 'supported') === v.supportsFastMode)) &&
  Array.isArray(v.input) &&
  v.input.every(string);
export const preferencesValid = (v: unknown): v is Preferences =>
  record(v) &&
  number(v.version) &&
  oneOf(v.busySendBehavior, ['queue', 'steer']) &&
  settingsValid(v.defaults);
export function frameValid(v: unknown): v is ConversationFrame {
  if (!record(v) || !string(v.type)) return false;
  if (v.type === 'command.result') {
    if (!string(v.commandId) || !bool(v.ok)) return false;
    if (!v.ok) {
      const error = v.error;
      return (
        record(error) &&
        ['type', 'title', 'detail', 'code', 'correlationId'].every((key) =>
          string(error[key]),
        ) &&
        number(error.status)
      );
    }
    return (
      record(v.data) &&
      (v.data.messageId === undefined || string(v.data.messageId)) &&
      (v.data.snapshot === undefined || snapshotValid(v.data.snapshot)) &&
      (v.data.snapshots === undefined ||
        arrayOf(v.data.snapshots, snapshotValid)) &&
      (v.data.messages === undefined ||
        arrayOf(v.data.messages, messageValid)) &&
      (v.data.historyCursor === undefined ||
        v.data.historyCursor === null ||
        string(v.data.historyCursor)) &&
      (v.data.hasOlderHistory === undefined || bool(v.data.hasOlderHistory))
    );
  }
  if (!string(v.generation) || !integer(v.sequence)) return false;
  switch (v.type) {
    case 'connection.state':
      return oneOf(v.state, ['ready', 'unavailable']);
    case 'conversation.snapshot':
      return snapshotValid(v.snapshot);
    case 'conversation.updated':
      return chatValid(v.chat);
    case 'conversation.deleted':
      return string(v.chatId);
    case 'conversation.run.text':
      return (
        string(v.chatId) &&
        string(v.runId) &&
        string(v.text) &&
        v.text.length <= 256 * 1024 &&
        bool(v.replace) &&
        integer(v.runSequence) &&
        (v.truncated === undefined || bool(v.truncated))
      );
    case 'conversation.tool':
      return string(v.chatId) && toolValid(v.tool);
    default:
      return false;
  }
}
