import type {
  ChatSnapshot,
  ChatSummary,
  ConversationEvent,
  Message,
  ToolActivity,
} from '@messenger/contracts';
import type { StoreApi } from 'zustand';
export interface ProjectionState {
  chats: Record<string, ChatSummary>;
  snapshots: Record<string, ChatSnapshot>;
  tools: Record<string, ToolActivity[]>;
  generation: string | null;
  connectionEpoch: number;
  needsReconnect: boolean;
  sequence: number;
  chatSequences: Record<string, number>;
  snapshotReadOrders: Record<string, number>;
  structuralSequences: Record<string, number>;
  runEventSequences: Record<string, number>;
  toolEventSequences: Record<string, Record<string, number>>;
  resyncChats: Record<string, boolean>;
  runBacklog: Record<
    string,
    Extract<ConversationEvent, { type: 'conversation.run.text' }>[]
  >;
  runDropped: Record<
    string,
    Extract<ConversationEvent, { type: 'conversation.run.text' }>
  >;
  olderHistory: Record<
    string,
    { messages: Message[]; cursor: string | null; hasOlder: boolean }
  >;
  transport: 'connecting' | 'open' | 'closed';
  deletedChats: Record<string, number>;
  connection: 'connecting' | 'ready' | 'unavailable';
  replaceCatalog(chats: ChatSummary[]): void;
  applyCatalogResult(
    chats: ChatSummary[],
    sequences: Record<string, number>,
    requestEpoch: number,
  ): void;
  releaseConfirmedChat(chatId: string): void;
  mergeChat(chat: ChatSummary): void;
  receiveEvent(event: ConversationEvent): void;
  beginConnection(): void;
  markUnavailable(): void;
  markTransportOpen(): void;
  markTransportClosed(): void;
  applySnapshot(
    snapshot: ChatSnapshot,
    replayBacklog?: boolean,
    afterSequence?: number,
  ): void;
  applySnapshotResult(
    snapshots: ChatSnapshot[],
    sequences: Record<string, number>,
    completeCatalog: boolean,
    requestOrder?: number,
    requestEpoch?: number,
  ): void;
  prependHistory(
    chatId: string,
    messages: Message[],
    cursor: string | null,
    hasOlder: boolean,
  ): void;
  clear(): void;
}
export type ProjectionSet = StoreApi<ProjectionState>['setState'];
export type ProjectionGet = StoreApi<ProjectionState>['getState'];
