import { agentBehaviorEqual, type ChatSettings } from '@messenger/contracts';
import type { GatewayContext } from './context.js';
import type { GatewayMapping } from './types.js';
import { ApplicationError } from '../errors.js';
import { canonicalModel } from './messages.js';
import { patchResultSchema } from './protocol-schemas.js';
export class SettingsOperations {
  constructor(private readonly context: GatewayContext) {}
  async settings(
    mapping: GatewayMapping,
    desired: ChatSettings,
  ): Promise<ChatSettings> {
    const generation = this.context.capabilityGeneration;
    // Read and validate before mutating either native resource. The operation stays
    // recoverable if session patch, conditional file write or readback is uncertain.
    await this.context.instructions.read(mapping);
    const data = patchResultSchema.parse(
      await this.context.request('sessions.patch', {
        key: mapping.sessionKey,
        agentId: mapping.agentId,
        model: desired.model,
        thinkingLevel: desired.thinkingLevel,
        fastMode: desired.fastMode,
      }),
    );
    const effective = {
      model: canonicalModel(data.resolved.modelProvider, data.resolved.model),
      thinkingLevel:
        data.resolved.thinkingLevel ??
        data.entry.thinkingLevel ??
        desired.thinkingLevel,
      fastMode: data.entry.fastMode === true,
      ...(await this.context.instructions.apply(mapping, desired)),
    };
    if (generation === this.context.capabilityGeneration)
      this.context.knownSettings.set(mapping.sessionKey, effective);
    const readBack = await this.context.history(mapping);
    if (!agentBehaviorEqual(effective, readBack.settings))
      throw new ApplicationError(
        409,
        'AGENT_INSTRUCTIONS_UNCONFIRMED',
        'Agent instructions changed during verification. Refresh before trying again.',
      );
    return readBack.settings;
  }
}
