import type { EngineContext, ManagerEngine } from './types.js';
import { ChatService } from '../../../backend/src/chats/service.js';
import { GatewayUnavailableError } from '../../../backend/src/errors.js';
import { NativeGateway } from '../engine/gateway/native.js';
import { PrivateContainer } from '../engine/container.js';
import { EngineDriver } from '../engine/driver.js';
import { DurableLifecycle } from '../engine/lifecycle/index.js';
import { materializeChats } from '../engine/creation.js';
import { cacheOnlyCommand } from '../engine/cached-commands.js';
import type { ManagerFiles } from '../files/service.js';
import type { BrowserBoundary } from '../files/boundary.js';
import { EngineFiles } from '../engine/files/service.js';
import { UploadMedia } from '../files/uploads/media.js';
import { pruneCachedSnapshot } from './cached-window.js';
import { containerFileSecrets } from '../files/secrets.js';

/** Engine work belongs to the manager, independently of browser sessions. */
export function createManagerEngine(
  context: EngineContext,
  files: ManagerFiles,
  boundary: BrowserBoundary,
): ManagerEngine | undefined {
  if (!context.state.container) return undefined;
  const control = new PrivateContainer(context);
  const engineFiles: EngineFiles = new EngineFiles({
    storage: context.state.storage,
    helper: (path, init) => control.fetch(path, init),
    catalog: files.catalog,
    summary: (mapping, summary) => {
      const chat = context.store
        .listChats()
        .find(
          (chat) =>
            chat.agentId === mapping.agentId &&
            chat.sessionKey === mapping.sessionKey,
        );
      if (chat)
        context.publish({
          type: 'conversation.tool',
          chatId: chat.id,
          tool: {
            id: summary.id,
            name: summary.operation,
            status: summary.status,
            parameters: '',
            output: summary.text,
          },
          generation: 'manager',
          sequence: 0,
        });
    },
    secrets: () => containerFileSecrets(context),
    mapping: (sessionKey) => {
      const chat = context.store
        .listChats()
        .find((chat) => chat.sessionKey === sessionKey && chat.agentId);
      return chat?.agentId ? { agentId: chat.agentId, sessionKey } : null;
    },
  });
  const gateway: NativeGateway = new NativeGateway({
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
    observe: (frame) => engineFiles.observe(frame),
    publicationPolicy: () => ({
      ...files.catalog.policy(),
      secrets: [
        ...control.secrets(),
        context.env.R2_ACCESS_KEY_ID ?? '',
        context.env.R2_SECRET_ACCESS_KEY ?? '',
        context.env.OPENAI_API_KEY ?? '',
        context.env.ANTHROPIC_API_KEY ?? '',
      ],
    }),
  });
  const media = new UploadMedia(files.uploads, gateway);
  media.setHandoff(async (mapping, uploads) => {
    const result = await engineFiles.handoff({ ...mapping, uploads });
    return result.uploads.map((file) => {
      files.recordInputPath(file.id, file.path);
      const original = uploads.find((upload) => upload.id === file.id)!;
      return {
        type: file.mimeType.startsWith('image/')
          ? ('image' as const)
          : ('file' as const),
        fileName: file.name,
        mimeType: file.mimeType,
        content: '',
        sizeBytes: original.size,
        origin: 'file' as const,
        nativePath: file.path,
      };
    });
  });
  const service = new ChatService(context.store, gateway, media, {
    backgroundReconciliation: false,
    projectSnapshot: (snapshot) =>
      pruneCachedSnapshot(context.store, boundary.project(snapshot)),
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
  driver.activeReaders = () => files.readers.live();
  driver.beforeCapture = async () => {
    await engineFiles.audit();
    await files.inputs.audit((mapping, id) =>
      engineFiles.inputMetadata(mapping, id),
    );
  };
  driver.additionalWork = () => engineFiles.busy();
  driver.onCommit = (descriptor) => files.commit(descriptor);
  files.liveFiles = {
    usable: () =>
      control.container.running &&
      [
        'ready',
        'preparing',
        'stopping-writers',
        'capturing',
        'verifying',
        'committing',
        'cancelling',
        'recovering',
      ].includes(lifecycle.status),
    read: (mapping, path) => engineFiles.read(mapping, path),
    readInput: (mapping, id) => engineFiles.readInput(mapping, id),
  };
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
