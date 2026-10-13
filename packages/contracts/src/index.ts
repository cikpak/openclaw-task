export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  correlationId: string;
}

import type { AgentBehavior } from './agent-behavior.js';
export * from '@messenger/contracts/agent-behavior';

export interface ChatSettings extends Partial<AgentBehavior> {
  model: string;
  thinkingLevel: string;
  fastMode: boolean;
}
export interface ModelCapability {
  id: string;
  name: string;
  provider: string;
  available: boolean;
  thinkingLevels: { id: string; label: string }[];
  thinkingDefault: string;
  supportsFastMode: boolean;
  fastModeSupport?: 'supported' | 'unsupported' | 'unknown' | undefined;
  input: string[];
}
export type ChatStatus =
  'creating' | 'idle' | 'running' | 'deleting' | 'recovery';
export interface ChatSummary {
  id: string;
  name: string;
  status: ChatStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  unread: boolean;
  settings: ChatSettings;
}
export interface Attachment {
  uploadId: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional validated path relative to this agent's workspace, never a server path. */
  sourcePath?: string | undefined;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: number;
  runId?: string | undefined;
  /** Native display sequence, not raw physical transcript position. */
  historySequence?: number | undefined;
  /** Explicit native assistant-request failure; never inferred from reply text. */
  requestFailed?: boolean | undefined;
  toolCallId?: string | undefined;
  toolName?: 'read' | 'write' | 'edit' | 'web_fetch' | undefined;
  attachments?: Attachment[] | undefined;
  artifacts?: Artifact[] | undefined;
}
export interface PendingMessage {
  id: string;
  chatId: string;
  position: number;
  text: string;
  attachments: Attachment[];
  revision: number;
  state: 'pending' | 'submitting' | 'submitted' | 'unknown' | 'cancelled';
  submissionId: string;
  createdAt: number;
}
export interface SettingsOperation {
  id: string;
  settings: ChatSettings;
  policy: 'when-idle' | 'cancel-work';
  status: 'pending' | 'applying' | 'unknown' | 'failed';
}
export interface ChatSnapshot {
  chat: ChatSummary;
  messages: Message[];
  pending: PendingMessage[];
  activeRun: ActiveRun | null;
  /** Non-canonical terminal text retained only while history catches up. */
  settledRun?: SettledRun | undefined;
  hiddenPendingCount?: number | undefined;
  pendingSettings: SettingsOperation | null;
  hasOlderHistory: boolean;
  historyCursor: string | null;
  tools?: ToolActivity[] | undefined;
}
export interface ActiveRun {
  id: string;
  text: string;
  sequence: number;
  truncated?: boolean | undefined;
}
export interface SettledRun extends ActiveRun {
  state: 'final' | 'error' | 'aborted';
}
export interface Preferences {
  version: number;
  busySendBehavior: 'queue' | 'steer';
  defaults: ChatSettings;
}
export interface CreateChatRequest {
  commandId: string;
  name?: string | undefined;
  settings: ChatSettings;
  initialMessage?:
    { text: string; uploadIds?: string[] | undefined } | undefined;
}
export interface SessionState {
  authenticated: boolean;
  username?: string;
  expiresAt?: number;
}
export interface ModelsResponse {
  models: ModelCapability[];
}
export interface ChatsResponse {
  chats: ChatSummary[];
}
export interface SettingsResponse {
  effective: ChatSettings;
  pending: SettingsOperation | null;
  version: number;
}
export type ConversationCommand =
  | {
      type: 'conversation.message.send';
      commandId: string;
      chatId: string;
      text: string;
      uploadIds?: string[] | undefined;
      behavior?: 'queue' | 'steer' | undefined;
    }
  | {
      type: 'conversation.message.editQueued';
      commandId: string;
      chatId: string;
      messageId: string;
      revision: number;
      text: string;
      uploadIds?: string[] | undefined;
    }
  | {
      type:
        | 'conversation.message.cancelQueued'
        | 'conversation.message.steerQueued';
      commandId: string;
      chatId: string;
      messageId: string;
      revision: number;
    }
  | { type: 'conversation.run.abort'; commandId: string; chatId: string }
  | {
      type: 'conversation.message.resolveUnknown';
      commandId: string;
      chatId: string;
      messageId: string;
      revision: number;
      action: 'discard' | 'retry';
    }
  | {
      type: 'conversation.snapshot.request';
      commandId: string;
      chatId?: string | undefined;
    }
  | {
      type: 'conversation.history.request';
      commandId: string;
      chatId: string;
      cursor?: string | undefined;
    }
  | { type: 'conversation.message.read'; commandId: string; chatId: string };
export type ConversationResult =
  | {
      type: 'command.result';
      commandId: string;
      ok: true;
      data: {
        messageId?: string | undefined;
        snapshot?: ChatSnapshot | undefined;
        snapshots?: ChatSnapshot[] | undefined;
        messages?: Message[] | undefined;
        historyCursor?: string | null | undefined;
        hasOlderHistory?: boolean | undefined;
      };
    }
  | {
      type: 'command.result';
      commandId: string;
      ok: false;
      error: ProblemDetails;
    };
export type ConversationEvent =
  | {
      type: 'connection.state';
      state: 'ready' | 'unavailable';
      generation: string;
      sequence: number;
    }
  | {
      type: 'conversation.snapshot';
      snapshot: ChatSnapshot;
      generation: string;
      sequence: number;
    }
  | {
      type: 'conversation.updated';
      chat: ChatSummary;
      generation: string;
      sequence: number;
    }
  | {
      type: 'conversation.deleted';
      chatId: string;
      generation: string;
      sequence: number;
    }
  | {
      type: 'conversation.run.text';
      chatId: string;
      runId: string;
      text: string;
      replace: boolean;
      runSequence: number;
      truncated?: boolean | undefined;
      generation: string;
      sequence: number;
    }
  | {
      type: 'conversation.tool';
      chatId: string;
      tool: ToolActivity;
      generation: string;
      sequence: number;
    };
export interface ToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  parameters: string;
  output: string;
}
export type ConversationFrame = ConversationResult | ConversationEvent;
