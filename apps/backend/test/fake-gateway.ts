import type { ChatSettings, ModelCapability } from '@messenger/contracts';
import type {
  Gateway,
  GatewayEvent,
  GatewayHistory,
  GatewayMapping,
} from '../src/gateway/types.js';
import { settingsSchema } from '../src/schemas.js';
// Keep three-field inputs to exercise compatibility; only expectations are normalized.
export const testSettings: ChatSettings = {
  model: 'test/model',
  thinkingLevel: 'off',
  fastMode: false,
};
export const normalizedTestSettings = settingsSchema.parse(testSettings);
export class FakeGateway implements Gateway {
  ready = true;
  failCreation = false;
  failSend = false;
  acceptThenFail = false;
  failSettings = false;
  failRemove = false;
  createThenFail = false;
  sends: { id: string; text: string; mapping: GatewayMapping }[] = [];
  titles: { mapping: GatewayMapping; model: string; text: string }[] = [];
  readonly histories = new Map<string, GatewayHistory>();
  private readonly verifiedModels = new Map<string, ModelCapability[]>();
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  start(): void {}
  stop(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  models(mapping?: GatewayMapping): Promise<ModelCapability[]> {
    const models: ModelCapability[] = [
      {
        id: 'test/model',
        name: 'Test model',
        provider: 'test',
        available: true,
        thinkingLevels: [
          { id: 'off', label: 'Off' },
          { id: 'high', label: 'High' },
        ],
        thinkingDefault: 'off',
        supportsFastMode: true,
        input: ['text', 'image'],
      },
    ];
    if (mapping)
      this.verifiedModels.set(
        JSON.stringify([mapping.agentId, mapping.sessionKey]),
        structuredClone(models),
      );
    return Promise.resolve(models);
  }
  cachedModels(mapping: GatewayMapping): ModelCapability[] | null {
    return structuredClone(
      this.verifiedModels.get(
        JSON.stringify([mapping.agentId, mapping.sessionKey]),
      ) ?? null,
    );
  }
  create(id: string, settings: ChatSettings): Promise<GatewayMapping> {
    if (this.failCreation)
      return Promise.reject(new Error('secret upstream error'));
    const mapping = { agentId: `agent-${id}`, sessionKey: `agent:${id}:main` };
    this.histories.set(mapping.sessionKey, {
      messages: [],
      activeRun: null,
      historyCursor: null,
      hasOlderHistory: false,
      settings,
      receipts: [],
      sessionId: `session-${id}`,
    });
    if (this.createThenFail)
      return Promise.reject(new Error('Creation acknowledgement lost'));
    return this.models(mapping).then(() => mapping);
  }
  recoverCreation(
    id: string,
    _settings: ChatSettings,
  ): Promise<GatewayMapping | null> {
    void _settings;
    return this.lookupCreation(id);
  }
  lookupCreation(id: string): Promise<GatewayMapping | null> {
    const sessionKey = `agent:${id}:main`;
    return Promise.resolve(
      this.histories.has(sessionKey)
        ? { agentId: `agent-${id}`, sessionKey }
        : null,
    );
  }
  exists(mapping: GatewayMapping): Promise<boolean> {
    return Promise.resolve(this.histories.has(mapping.sessionKey));
  }
  title(
    mapping: GatewayMapping,
    model: string,
    text: string,
  ): Promise<string | null> {
    this.titles.push({ mapping, model, text });
    return Promise.resolve(null);
  }
  remove(mapping: GatewayMapping): Promise<void> {
    this.histories.delete(mapping.sessionKey);
    if (this.failRemove)
      return Promise.reject(new Error('Deletion acknowledgement lost'));
    return Promise.resolve();
  }
  history(
    mapping: GatewayMapping,
    options: { cursor?: string; inputRunIds?: string[] } = {},
  ): Promise<GatewayHistory> {
    const history = this.histories.get(mapping.sessionKey);
    return history
      ? Promise.resolve(
          options.inputRunIds
            ? {
                ...history,
                receipts: history.receipts.filter((receipt) =>
                  options.inputRunIds?.includes(receipt.runId),
                ),
              }
            : history,
        )
      : Promise.reject(new Error('Missing history'));
  }
  settings(
    mapping: GatewayMapping,
    settings: ChatSettings,
  ): Promise<ChatSettings> {
    const history = this.histories.get(mapping.sessionKey);
    if (history) history.settings = settings;
    if (this.failSettings)
      return Promise.reject(new Error('Settings acknowledgement lost'));
    return Promise.resolve(settings);
  }
  send(
    mapping: GatewayMapping,
    submissionId: string,
    text: string,
    _behavior: 'queue' | 'steer' = 'queue',
  ): Promise<{ runId: string; status: string }> {
    void _behavior;
    this.sends.push({ id: submissionId, text, mapping });
    if (this.failSend)
      return Promise.reject(new Error('Timeout after acceptance'));
    const history = this.histories.get(mapping.sessionKey);
    if (history) {
      if (history.receipts.some((receipt) => receipt.runId === submissionId))
        return Promise.resolve({ runId: submissionId, status: 'accepted' });
      history.messages.push({
        id: submissionId,
        text,
        role: 'user',
        createdAt: Date.now(),
      });
      history.receipts.push({ runId: submissionId, state: 'pending' });
      if (!history.activeRun)
        history.activeRun = { id: submissionId, text: '', sequence: 0 };
    }
    if (this.acceptThenFail)
      return Promise.reject(new Error('Send acknowledgement lost'));
    return Promise.resolve({ runId: submissionId, status: 'started' });
  }
  abort(mapping: GatewayMapping): Promise<void> {
    const history = this.histories.get(mapping.sessionKey);
    if (history) {
      history.activeRun = null;
      for (const receipt of history.receipts)
        if (receipt.state === 'pending') receipt.cancelled = true;
    }
    return Promise.resolve();
  }
  complete(mapping: GatewayMapping, runId: string, sequence = 1): void {
    const history = this.histories.get(mapping.sessionKey);
    if (history) {
      if (history.activeRun?.id === runId) history.activeRun = null;
      const receipt = history.receipts.find((item) => item.runId === runId);
      if (receipt) receipt.state = 'consumed';
    }
    this.emit({
      type: 'chat',
      sessionKey: mapping.sessionKey,
      runId,
      sequence,
      state: 'final',
      text: '',
      replace: true,
    });
  }
}
