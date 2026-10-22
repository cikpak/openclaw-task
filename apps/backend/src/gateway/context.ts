import type {
  Artifact,
  ChatSettings,
  ModelCapability,
} from '@messenger/contracts';
import type { AgentInstructions } from './agent-instructions.js';
import type { GatewayMapping, GatewayEvent, GatewayHistory } from './types.js';
export interface GatewayTransport {
  ready: boolean;
  maxPayload: number;
  readonly stopped: boolean;
  start(): void;
  stop(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}
export interface GatewayFiles {
  list(mapping: GatewayMapping): Promise<Artifact[]>;
  handles(id: string): boolean;
  download(
    mapping: GatewayMapping,
    id: string,
  ): Promise<{ artifact: Artifact; bytes: Buffer }>;
  sourcePath(mapping: GatewayMapping, path: string): string;
}
export interface GatewayContext {
  transport: GatewayTransport;
  instructions: AgentInstructions;
  workspace: GatewayFiles;
  knownSettings: Map<string, ChatSettings>;
  verifiedModels: Map<string, ModelCapability[]>;
  capabilityGeneration: number;
  agentConfigurationTail: Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  history(mapping: GatewayMapping): Promise<GatewayHistory>;
  settings(
    mapping: GatewayMapping,
    settings: ChatSettings,
  ): Promise<ChatSettings>;
  models(mapping?: GatewayMapping): Promise<ModelCapability[]>;
  fullMessage?:
    | ((mapping: GatewayMapping, messageId: string) => Promise<unknown>)
    | undefined;
}
export type GatewayEventListener = (event: GatewayEvent) => void;
