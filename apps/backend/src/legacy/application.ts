import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from '../config.js';
import { registerErrors } from './errors.js';
declare module '@fastify/secure-session' {
  interface SessionData {
    sessionId: string;
    expiresAt: number;
  }
}

export async function createApplication(config: Config, logger = false) {
  const app = Fastify({
    // Legacy test adapter retains its explicit trusted-hop configuration.
    trustProxy:
      config.trustProxyHops === 1 ? (_address, hop) => hop === 0 : false,
    logger: logger
      ? {
          redact: {
            paths: [
              'req.url',
              'req.query.ticket',
              'req.headers.cookie',
              'req.headers.authorization',
              'req.body',
              'res.headers.set-cookie',
            ],
            censor: '[REDACTED]',
          },
        }
      : false,
    // 32,000 schema characters can require six JSON bytes each, plus metadata.
    bodyLimit: 262144,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(secureSession, {
    key: config.sessionKey,
    cookieName: config.secureCookies ? '__Host-messenger' : 'messenger',
    expiry: config.sessionLifetimeSeconds,
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.secureCookies,
      maxAge: config.sessionLifetimeSeconds,
    },
  });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 262144 } });
  registerErrors(app, config.origin);
  return app;
}
export type LegacyApp = Awaited<ReturnType<typeof createApplication>>;
