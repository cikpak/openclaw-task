import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Store } from '../database.js';
import type { Gateway } from '../gateway/types.js';
import type { ChatService } from '../chats/service.js';
import type { LegacyApp } from './application.js';

/** Compatibility adapter for existing domain/HTTP regression tests only. */
export interface LegacyContext {
  app: LegacyApp;
  config: Config;
  store: Store;
  gateway: Gateway;
  chats: ChatService;
  sessionSockets: Map<string, Set<WebSocket>>;
  sessionId: (request: FastifyRequest) => string;
  protectedRoute: (request: FastifyRequest) => Promise<void>;
}
