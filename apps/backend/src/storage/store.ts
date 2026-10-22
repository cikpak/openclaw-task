import type {
  ChatSummary,
  PendingMessage,
  SettingsOperation,
} from '@messenger/contracts';
import type { z } from 'zod';
import type { resultSchema } from '../schemas.js';
type CommandResult = z.infer<typeof resultSchema>;

export interface SqlStatement {
  get(...bindings: unknown[]): unknown;
  all(...bindings: unknown[]): unknown[];
  run(...bindings: unknown[]): unknown;
}
/** Synchronous SQLite boundary shared by Node and SQLite Durable Objects. */
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  exec(query: string): unknown;
  transaction<T>(work: () => T): () => T;
  close(): void;
}

export interface ChatRecord extends ChatSummary {
  agentId: string | null;
  sessionKey: string | null;
  creationId: string;
}
export interface ChatMetadata {
  manualName: boolean;
  creationInput: unknown;
  titleText?: string | undefined;
  titleFallback?: string | undefined;
  titleRequested?: boolean | undefined;
}
/** Application persistence only; the deployment adapter owns its database lifetime. */
export interface Store {
  readonly db: SqlDatabase;
  close(): void;
  createSession(id: string, expiresAt: number): void;
  sessionValid(id: string, now?: number): boolean;
  revokeSession(id: string): void;
  listChats(): ChatRecord[];
  getChat(id: string): ChatRecord;
  findCreation(creationId: string): ChatRecord | undefined;
  reserveChat(chat: ChatRecord): void;
  saveChat(chat: ChatRecord): void;
  removeChat(id: string): void;
  creationCommand(
    id: string,
  ): { chatId: string; input: string; deleted: boolean } | null;
  saveCreationCommand(id: string, chatId: string, input: unknown): void;
  saveTombstone(chat: ChatRecord): void;
  tombstones(): ChatRecord[];
  pending(id: string): PendingMessage[];
  savePending(item: PendingMessage): void;
  removePending(
    id: string,
    outcome?: 'removed' | 'consumed' | 'cancelled',
  ): void;
  submissionScope(id: string): string | null;
  saveSubmissionScope(id: string, sessionId: string): void;
  settingsOperation(id: string): SettingsOperation | null;
  saveSettingsOperation(
    chatId: string,
    operation: SettingsOperation | null,
  ): void;
  metadata(id: string): ChatMetadata;
  saveMetadata(id: string, data: ChatMetadata): void;
  commandRequest(id: string): string | null;
  saveCommandRequest(id: string, json: string): void;
  getCommand(id: string): CommandResult | null;
  saveCommand(result: CommandResult): void;
}
