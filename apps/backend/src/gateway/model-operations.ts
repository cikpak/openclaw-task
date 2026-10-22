import type { ModelCapability } from '@messenger/contracts';
import type { GatewayContext } from './context.js';
import type { GatewayMapping } from './types.js';
import { canonicalModel } from './messages.js';
import { modelResultSchema } from './protocol-schemas.js';
export class ModelOperations {
  constructor(private readonly context: GatewayContext) {}
  async models(mapping?: GatewayMapping): Promise<ModelCapability[]> {
    const generation = this.context.capabilityGeneration;
    const knownScope =
      mapping && this.context.knownSettings.has(mapping.sessionKey);
    const data = modelResultSchema.parse(
      await this.context.request('models.list', {
        includeDetails: true,
        view: 'configured',
        ...(mapping
          ? { agentId: mapping.agentId, sessionKey: mapping.sessionKey }
          : {}),
      }),
    );
    const models = data.models.map((m) => ({
      id: canonicalModel(m.provider, m.id),
      name: m.name,
      provider: m.provider,
      available: m.available !== false && m.manualSelectionAllowed !== false,
      thinkingLevels: m.thinkingLevels ?? [{ id: 'off', label: 'Off' }],
      thinkingDefault: m.thinkingDefault ?? m.thinkingLevels?.[0]?.id ?? 'off',
      supportsFastMode: m.supportsFastMode === true,
      fastModeSupport:
        m.supportsFastMode === undefined
          ? ('unknown' as const)
          : m.supportsFastMode
            ? ('supported' as const)
            : ('unsupported' as const),
      input: m.input ?? ['text'],
    }));
    if (
      mapping &&
      knownScope &&
      generation === this.context.capabilityGeneration &&
      this.context.knownSettings.has(mapping.sessionKey)
    ) {
      const key = JSON.stringify([mapping.agentId, mapping.sessionKey]);
      this.context.verifiedModels.delete(key);
      // The application has at most ten active agents. Catalogs are bounded too.
      this.context.verifiedModels.set(
        key,
        structuredClone(models.slice(0, 500)),
      );
      if (this.context.verifiedModels.size > 10) {
        const oldest = this.context.verifiedModels.keys().next().value;
        if (oldest) this.context.verifiedModels.delete(oldest);
      }
    }
    return models;
  }
  cachedModels(mapping: GatewayMapping): ModelCapability[] | null {
    const models = this.context.verifiedModels.get(
      JSON.stringify([mapping.agentId, mapping.sessionKey]),
    );
    return models ? structuredClone(models) : null;
  }
}
