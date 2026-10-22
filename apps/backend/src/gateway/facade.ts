import type { ChatSettings } from '@messenger/contracts';
import { AgentInstructions } from './agent-instructions.js';
import type {
  GatewayContext,
  GatewayEventListener,
  GatewayFiles,
  GatewayTransport,
} from './context.js';
import type { Gateway, GatewayAttachment, GatewayMapping } from './types.js';
import { ModelOperations } from './model-operations.js';
import { AgentOperations } from './agent-operations.js';
import { SettingsOperations } from './settings-operations.js';
import { HistoryOperations } from './history-operations.js';
import { FileOperations } from './file-operations.js';
import { SendOperations } from './send-operations.js';
export class GatewayFacade implements Gateway {
  private readonly modelsApi: ModelOperations;
  private readonly agentsApi: AgentOperations;
  private readonly settingsApi: SettingsOperations;
  private readonly historyApi: HistoryOperations;
  private readonly filesApi: FileOperations;
  private readonly sendApi: SendOperations;
  protected readonly listeners = new Set<GatewayEventListener>();
  constructor(
    protected readonly transport: GatewayTransport,
    files: GatewayFiles,
    fullMessage?: GatewayContext['fullMessage'],
  ) {
    const context: GatewayContext = {
      transport,
      workspace: files,
      fullMessage,
      instructions: new AgentInstructions((method, params) =>
        this.request(method, params),
      ),
      knownSettings: new Map(),
      verifiedModels: new Map(),
      capabilityGeneration: 0,
      agentConfigurationTail: Promise.resolve(),
      request: (method, params) => this.request(method, params),
      history: (mapping) => this.history(mapping),
      settings: (mapping, settings) => this.settings(mapping, settings),
      models: (mapping) => this.models(mapping),
    };
    this.modelsApi = new ModelOperations(context);
    this.agentsApi = new AgentOperations(context);
    this.settingsApi = new SettingsOperations(context);
    this.historyApi = new HistoryOperations(context);
    this.filesApi = new FileOperations(context);
    this.sendApi = new SendOperations(context);
  }
  get ready() {
    return this.transport.ready;
  }
  set ready(value: boolean) {
    this.transport.ready = value;
  }
  set maxPayload(value: number) {
    this.transport.maxPayload = value;
  }
  get maxPayload() {
    return this.transport.maxPayload;
  }
  start() {
    this.transport.start();
  }
  stop() {
    return this.transport.stop();
  }
  request(method: string, params: unknown): Promise<unknown> {
    return this.transport.request(method, params);
  }
  onEvent(listener: GatewayEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected emit(event: Parameters<GatewayEventListener>[0]) {
    for (const listener of this.listeners) listener(event);
  }
  models(mapping?: GatewayMapping) {
    return this.modelsApi.models(mapping);
  }
  cachedModels(mapping: GatewayMapping) {
    return this.modelsApi.cachedModels(mapping);
  }
  create(id: string, settings: ChatSettings) {
    return this.agentsApi.create(id, settings);
  }
  recoverCreation(id: string, settings: ChatSettings) {
    return this.agentsApi.recoverCreation(id, settings);
  }
  lookupCreation(id: string) {
    return this.agentsApi.lookupCreation(id);
  }
  title(mapping: GatewayMapping, model: string, message: string) {
    return this.agentsApi.title(mapping, model, message);
  }
  exists(mapping: GatewayMapping) {
    return this.agentsApi.exists(mapping);
  }
  subscribe(mapping: GatewayMapping) {
    return this.agentsApi.subscribe(mapping);
  }
  remove(mapping: GatewayMapping) {
    return this.agentsApi.remove(mapping);
  }
  settings(mapping: GatewayMapping, settings: ChatSettings) {
    return this.settingsApi.settings(mapping, settings);
  }
  history(
    mapping: GatewayMapping,
    options: { cursor?: string; inputRunIds?: string[] } = {},
  ) {
    return this.historyApi.history(mapping, options);
  }
  send(
    mapping: GatewayMapping,
    id: string,
    text: string,
    behavior: 'queue' | 'steer',
    attachments?: GatewayAttachment[],
  ) {
    return this.sendApi.send(mapping, id, text, behavior, attachments);
  }
  abort(mapping: GatewayMapping) {
    return this.sendApi.abort(mapping);
  }
  artifacts(mapping: GatewayMapping) {
    return this.filesApi.artifacts(mapping);
  }
  artifact(mapping: GatewayMapping, id: string) {
    return this.filesApi.artifact(mapping, id);
  }
  resolveArtifact(mapping: GatewayMapping, path: string) {
    return this.filesApi.resolveArtifact(mapping, path);
  }
}
