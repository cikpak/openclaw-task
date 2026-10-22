import type { EngineContext, ManagerEngine } from './types.js';
import { ChatService } from '../../../backend/src/chats/service.js';
import { GatewayUnavailableError } from '../../../backend/src/errors.js';
import { NativeGateway } from '../engine/gateway/native.js';
import { PrivateContainer } from '../engine/container.js';
import { EngineDriver } from '../engine/driver.js';
import { DurableLifecycle } from '../engine/lifecycle/index.js';
import { materializeChats } from '../engine/creation.js';
import { cacheOnlyCommand } from '../engine/cached-commands.js';

/** Engine work belongs to the manager, independently of browser sessions. */
export function createManagerEngine(
  context: EngineContext,
): ManagerEngine | undefined {
  if (!context.state.container) return undefined;
  const control = new PrivateContainer(context);
  const gateway = new NativeGateway({
    fetcher: () => control.container.getTcpPort(18789),
    storage: context.state.storage,
    gatewayToken: control.gatewayToken(),
    pair: (identity) =>
      control.action('pair', { identity }, 255_000).then(() => {}),
    fullMessage: async (mapping, messageId) => {
      const result = (await control.action('full-message', {
        ...mapping,
        messageId,
      })) as { message: unknown };
      return result.message;
    },
    publicationPolicy: () => ({
      documentsRoots: [],
      publications: [],
      secrets: [
        ...control.secrets(),
        context.env.R2_ACCESS_KEY_ID ?? '',
        context.env.R2_SECRET_ACCESS_KEY ?? '',
        context.env.OPENAI_API_KEY ?? '',
        context.env.ANTHROPIC_API_KEY ?? '',
      ],
    }),
  });
  const service = new ChatService(context.store, gateway, undefined, {
    backgroundReconciliation: false,
  });
  service.onEvent((event) => {
    // Browser readiness means an authorized durable manager transport. Native
    // wake, suspension and reconnect must never disable Send or undo an ACK.
    if (event.type !== 'connection.state') context.publish(event);
  });
  const driver = new EngineDriver(context, control, gateway, service);
  const seconds = Number(context.env.ENGINE_IDLE_SECONDS ?? 60);
  const lifecycle = new DurableLifecycle(
    { storage: context.state.storage, schedule: context.schedule },
    driver,
    {
      idleMs:
        Number.isFinite(seconds) && seconds >= 1 ? seconds * 1000 : 60_000,
    },
  );
  driver.cancellationRequested = () => lifecycle.state.wantWake;
  const tick = async () => {
    await lifecycle.tick();
    if (lifecycle.ready && !service.reconciled) {
      await materializeChats(context.store, gateway, service);
      await service.reconcile();
    }
  };
  return {
    gateway,
    service,
    deadline: () => lifecycle.deadline(),
    tick,
    handle: (command) => cacheOnlyCommand(command, context.store, service),
    wake: async () => {
      await lifecycle.requestWake();
      const expires = Date.now() + 360_000;
      while (!lifecycle.ready && Date.now() < expires) {
        if (lifecycle.snapshot().failure === 'missing-checkpoint')
          throw new GatewayUnavailableError();
        await new Promise((resolve) => setTimeout(resolve, 500));
        await tick();
      }
      if (!lifecycle.ready) throw new GatewayUnavailableError();
      await materializeChats(context.store, gateway, service);
      await service.reconcile();
    },
  };
}
