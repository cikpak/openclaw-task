/** Legacy in-process adapter retained for domain/HTTP regression tests.
 * Production and local development use apps/cloudflare exclusively. */
import { join } from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { Store } from './database.js';
import { AuthenticationError } from './errors.js';
import type { Gateway } from './gateway/types.js';
import { OpenClawGateway } from './gateway/openclaw.js';
import { ChatService } from './chats/service.js';
import { UploadService } from './uploads/service.js';
import { registerMediaRoutes } from './uploads/routes.js';
import { createApplication } from './legacy/application.js';
import { registerSessions } from './legacy/sessions.js';
import { registerChats } from './legacy/chats.js';
import { registerPreferences } from './legacy/preferences.js';
import { registerConversation } from './legacy/conversation.js';
export interface ServerOptions {
  config: Config;
  gateway?: Gateway;
  store?: Store;
  logger?: boolean;
}
export async function buildServer(options: ServerOptions) {
  const { config } = options;
  const store =
    options.store ?? new Store(join(config.dataDir, 'messenger.sqlite'));
  const gateway = options.gateway ?? new OpenClawGateway(config);
  const uploads = new UploadService(
    store,
    config.dataDir,
    config.username,
    gateway,
  );
  const chats = new ChatService(store, gateway, uploads);
  const app = await createApplication(config, options.logger);
  const sessionSockets = new Map<string, Set<WebSocket>>();
  function sessionId(request: FastifyRequest): string {
    const id = request.session.get('sessionId');
    if (!id || !store.sessionValid(id)) throw new AuthenticationError();
    return id;
  }
  const protectedRoute = (request: FastifyRequest): Promise<void> => {
    sessionId(request);
    return Promise.resolve();
  };
  const context = {
    app,
    config,
    store,
    gateway,
    chats,
    sessionSockets,
    sessionId,
    protectedRoute,
  };
  registerSessions(context);
  registerChats(context);
  registerPreferences(context);
  registerConversation(context);
  await registerMediaRoutes(app, uploads, store, gateway, protectedRoute);
  const uploadCleanup = setInterval(() => {
    void uploads.cleanup().catch(() => {
      app.log.warn('Temporary upload cleanup failed');
    });
  }, 60000);
  uploadCleanup.unref();
  app.addHook('onClose', async () => {
    clearInterval(uploadCleanup);
    for (const sockets of sessionSockets.values())
      for (const socket of sockets) socket.close(1001, 'Server stopping');
    chats.close();
    await gateway.stop();
    store.close();
  });
  gateway.start();
  if (gateway.ready) await chats.reconcile();
  return { app, chats, gateway, store };
}
