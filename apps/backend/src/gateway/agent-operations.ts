import { z } from 'zod';
import type { ChatSettings } from '@messenger/contracts';
import type { GatewayContext } from './context.js';
import type { GatewayMapping } from './types.js';
import { GatewayUnavailableError } from '../errors.js';
import { agentsResultSchema } from './protocol-schemas.js';
import { setTimeout as delay } from 'node:timers/promises';
export class AgentOperations {
  constructor(private readonly context: GatewayContext) {}
  async create(id: string, settings: ChatSettings): Promise<GatewayMapping> {
    return this.withAgentConfiguration(async () => {
      const agent = z
        .object({ ok: z.literal(true), agentId: z.string() })
        .parse(
          await this.context.request('agents.create', {
            name: `messenger-${id}`,
            model: settings.model,
          }),
        );
      return this.initializeSession(id, agent.agentId, settings);
    });
  }
  async recoverCreation(
    id: string,
    settings: ChatSettings,
  ): Promise<GatewayMapping | null> {
    return this.withAgentConfiguration(async () => {
      const found = await this.lookupCreation(id);
      if (!found) return null;
      // This is only called for an unconfirmed creation. Ordinary reconnect only reads history.
      return this.initializeSession(id, found.agentId, settings);
    });
  }
  private async withAgentConfiguration<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    // Agent config is global; a later hot reload can replace another creation's database target.
    // This gate deliberately excludes ordinary chat sends, history and per-chat settings.
    const previous = this.context.agentConfigurationTail;
    let release!: () => void;
    this.context.agentConfigurationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async lookupCreation(id: string): Promise<GatewayMapping | null> {
    const expectedAgentId = `messenger-${id}`;
    const agents = agentsResultSchema.parse(
      await this.context.request('agents.list', {}),
    );
    const agent = agents.agents.find((entry) => entry.id === expectedAgentId);
    if (!agent) return null;
    return { agentId: agent.id, sessionKey: `agent:${agent.id}:main` };
  }
  async title(
    mapping: GatewayMapping,
    model: string,
    message: string,
  ): Promise<string | null> {
    return z
      .object({ title: z.string().trim().min(1).max(100).nullable() })
      .parse(
        await this.context.request('sessions.title.prepare', {
          agentId: mapping.agentId,
          model,
          message,
        }),
      ).title;
  }
  async exists(mapping: GatewayMapping): Promise<boolean> {
    const agents = agentsResultSchema.parse(
      await this.context.request('agents.list', {}),
    );
    return agents.agents.some((entry) => entry.id === mapping.agentId);
  }
  private async initializeSession(
    id: string,
    agentId: string,
    settings: ChatSettings,
  ): Promise<GatewayMapping> {
    // agents.create acknowledges the committed config before Gateway hot reload sees it.
    const deadline = Date.now() + 20_000;
    while (
      !(await this.exists({ agentId, sessionKey: `agent:${agentId}:main` }))
    ) {
      if (this.context.transport.stopped || Date.now() >= deadline)
        throw new GatewayUnavailableError();
      await delay(250);
    }
    const createParams = {
      agentId,
      key: `agent:${agentId}:main`,
      idempotencyKey: id,
      model: settings.model,
      thinkingLevel: settings.thinkingLevel,
      fastMode: settings.fastMode,
      permissionMode: 'workspace',
    };
    let created: unknown;
    for (;;) {
      try {
        created = await this.context.request('sessions.create', createParams);
        break;
      } catch (error) {
        const transient =
          error instanceof Error &&
          'code' in error &&
          error.code === 'INVALID_REQUEST' &&
          error.message.startsWith(`Unknown agent id "${agentId}".`);
        if (
          !transient ||
          this.context.transport.stopped ||
          Date.now() >= deadline
        )
          throw error;
        await delay(250);
      }
    }
    const session = z
      .object({ ok: z.literal(true), key: z.string() })
      .parse(created);
    const mapping = { agentId, sessionKey: session.key };
    await this.context.settings(mapping, settings);
    await this.context.models(mapping);
    await this.subscribe(mapping);
    return mapping;
  }
  async subscribe(mapping: GatewayMapping): Promise<void> {
    await this.context.request('sessions.messages.subscribe', {
      key: mapping.sessionKey,
      agentId: mapping.agentId,
    });
  }
  async remove(mapping: GatewayMapping): Promise<void> {
    return this.withAgentConfiguration(async () => {
      z.object({ ok: z.literal(true) }).parse(
        await this.context.request('agents.delete', {
          agentId: mapping.agentId,
          deleteFiles: true,
        }),
      );
      const deadline = Date.now() + 20_000;
      while (await this.exists(mapping)) {
        if (this.context.transport.stopped || Date.now() >= deadline)
          throw new GatewayUnavailableError();
        await delay(250);
      }
      // Invalidate older reads without accumulating per-deleted-agent tombstones.
      this.context.capabilityGeneration += 1;
      this.context.verifiedModels.delete(
        JSON.stringify([mapping.agentId, mapping.sessionKey]),
      );
      this.context.knownSettings.delete(mapping.sessionKey);
    });
  }
}
