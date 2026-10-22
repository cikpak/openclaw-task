import type {
  Attachment,
  ChatSettings,
  ChatSnapshot,
  ChatSummary,
  ConversationCommand,
  ConversationEvent,
  CreateChatRequest,
  Message,
  ModelCapability,
  Preferences,
  ProblemDetails,
  SettingsOperation,
  SettingsResponse,
} from './index.js';
import type { BrowserFile } from './browser-data.js';

export const UPLOAD_CHUNK_BYTES = 48 * 1024;
export const UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MESSAGE_BYTES = 10 * 1024 * 1024;
export const UPLOADS_PER_MESSAGE = 5;
export const PENDING_MESSAGES_PER_CHAT = 20;
export const UPLOAD_RETENTION_BYTES = 100 * 1024 * 1024;
export const UPLOAD_RETENTION_COUNT = 200;
export const UNUSED_UPLOAD_LIFETIME_MS = 60 * 60 * 1000;

/** Durable acceptance is separate from native execution, including across sleep. */
export interface CommandReceipt {
  commandId: string;
  acceptedAt: number;
  state: 'accepted' | 'dispatching' | 'submitted' | 'unknown' | 'completed';
  messageId?: string | undefined;
  submissionId?: string | undefined;
}
export interface HistoryViewport {
  width: number;
  height: number;
  fontSize: number;
  lineHeight: number;
}
type Base = { commandId: string };
type Chat = Base & { chatId: string };
/** Version is the existing HTTP If-Match value, expressed without quote syntax. */
type VersionedChat = Chat & { version: number };
export type ApplicationCommand =
  | (Base & { type: 'application.bootstrap.request' })
  | (Base & { type: 'chat.list' })
  | ({ type: 'chat.create' } & CreateChatRequest)
  | (Chat & { type: 'chat.get' })
  | (VersionedChat & { type: 'chat.rename'; name: string })
  | (VersionedChat & { type: 'chat.delete' | 'chat.recover' })
  | (Chat & { type: 'chat.settings.get' })
  | (VersionedChat & {
      type: 'chat.settings.update';
      settings: ChatSettings;
      policy: 'when-idle' | 'cancel-work';
    })
  | (VersionedChat & {
      type: 'chat.settings.resolve';
      action: 'retry' | 'discard';
    })
  | (Base & { type: 'preferences.get' })
  | (Base & {
      type: 'preferences.update';
      version: number;
      preferences: Omit<Preferences, 'version'>;
    })
  | (Base & {
      type: 'models.list';
      chatId?: string | undefined;
      cachedOnly?: boolean | undefined;
    })
  | (Chat & { type: 'files.list'; category: 'shared' | 'generated' | 'all' })
  | (Chat & { type: 'files.resolve'; fileId: string })
  | (Base & {
      type: 'upload.begin';
      name: string;
      mimeType: string;
      size: number;
    })
  | (Base & {
      type: 'upload.chunk';
      uploadId: string;
      offset: number;
      base64: string;
    })
  | (Base & { type: 'upload.complete' | 'upload.remove'; uploadId: string })
  | (Chat & { type: 'conversation.recent.request'; viewport: HistoryViewport })
  | (Base & { type: 'command.receipt.request'; receiptCommandId: string });
export type ManagerCommand = ConversationCommand | ApplicationCommand;
export interface ManagerResultData {
  messageId?: string | undefined;
  snapshot?: ChatSnapshot | undefined;
  snapshots?: ChatSnapshot[] | undefined;
  messages?: Message[] | undefined;
  historyCursor?: string | null | undefined;
  hasOlderHistory?: boolean | undefined;
  receipt?: CommandReceipt | undefined;
  chats?: ChatSummary[] | undefined;
  chat?: ChatSummary | undefined;
  settings?: SettingsResponse | undefined;
  settingsOperation?: SettingsOperation | undefined;
  preferences?: Preferences | undefined;
  models?: ModelCapability[] | undefined;
  files?: BrowserFile[] | undefined;
  file?: BrowserFile | undefined;
  download?: { url: string; expiresAt: number } | undefined;
  upload?: Attachment | undefined;
  uploadId?: string | undefined;
  nextOffset?: number | undefined;
  status?: 'deleting' | undefined;
}
export type ManagerResult =
  | {
      type: 'command.result';
      commandId: string;
      ok: true;
      data: ManagerResultData;
    }
  | {
      type: 'command.result';
      commandId: string;
      ok: false;
      error: ProblemDetails;
    };
export type ManagerFrame = ManagerResult | ConversationEvent;

/** Ordered JSON transport fragments; complete messages are never truncated. */
export interface ManagerChunk {
  type: 'manager.chunk';
  id: string;
  index: number;
  count: number;
  text: string;
}
