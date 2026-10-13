import type {
  ChatSettings,
  Message,
  ModelCapability,
  Artifact,
  ToolActivity,
} from '@messenger/contracts';
export interface GatewayMapping {
  agentId: string;
  sessionKey: string;
}
export interface GatewayHistory {
  sessionId?: string | undefined;
  messages: Message[];
  activeRun: { id: string; text: string; sequence: number } | null;
  historyCursor: string | null;
  hasOlderHistory: boolean;
  settings: ChatSettings;
  tools?: ToolActivity[];
  receipts: {
    runId: string;
    state: 'pending' | 'consumed';
    cancelled?: boolean | undefined;
  }[];
}
export type GatewayEvent =
  | { type: 'connection'; ready: boolean }
  | {
      type: 'tool';
      sessionKey: string;
      runId: string;
      sequence: number;
      tool: ToolActivity;
    }
  | {
      type: 'chat';
      sessionKey: string;
      runId: string;
      sequence: number;
      state: 'delta' | 'final' | 'aborted' | 'error' | 'status';
      text: string;
      replace: boolean;
    };
export interface Gateway {
  readonly ready: boolean;
  readonly maxPayload?: number;
  start(): void;
  stop(): Promise<void>;
  onEvent(listener: (event: GatewayEvent) => void): () => void;
  models(mapping?: GatewayMapping): Promise<ModelCapability[]>;
  cachedModels?(mapping: GatewayMapping): ModelCapability[] | null;
  create(id: string, settings: ChatSettings): Promise<GatewayMapping>;
  lookupCreation?(id: string): Promise<GatewayMapping | null>;
  title?(
    mapping: GatewayMapping,
    model: string,
    message: string,
  ): Promise<string | null>;
  recoverCreation?(
    id: string,
    settings: ChatSettings,
  ): Promise<GatewayMapping | null>;
  exists?(mapping: GatewayMapping): Promise<boolean>;
  remove(mapping: GatewayMapping): Promise<void>;
  history(
    mapping: GatewayMapping,
    options?: { cursor?: string; inputRunIds?: string[] },
  ): Promise<GatewayHistory>;
  settings(
    mapping: GatewayMapping,
    settings: ChatSettings,
  ): Promise<ChatSettings>;
  send(
    mapping: GatewayMapping,
    submissionId: string,
    text: string,
    behavior: 'queue' | 'steer',
    attachments?: GatewayAttachment[],
  ): Promise<{ runId: string; status: string }>;
  abort(mapping: GatewayMapping): Promise<void>;
  artifacts?(mapping: GatewayMapping): Promise<Artifact[]>;
  resolveArtifact?(mapping: GatewayMapping, path: string): Promise<Artifact>;
  artifact?(
    mapping: GatewayMapping,
    id: string,
  ): Promise<{ artifact: Artifact; bytes: Buffer }>;
}
export interface GatewayAttachment {
  type: 'image' | 'file';
  mimeType: string;
  fileName: string;
  content: string;
  sizeBytes: number;
  origin: 'file';
}
