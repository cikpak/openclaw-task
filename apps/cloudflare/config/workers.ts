import process from 'node:process';
import { bindings, defineWorker, exports } from 'cf/config';

// Query-bearing admission routes must never enter invocation/access URL logs.
export const telemetry = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: false },
  traces: { enabled: false },
};
export const backend = defineWorker({
  name: 'openclaw-messenger-backend',
  entrypoint: './src/auth/worker.ts',
  compatibilityDate: '2026-10-22',
  compatibilityFlags: ['nodejs_compat'],
  workersDev: false,
  previewUrls: false,
  observability: telemetry,
  env: {
    AUTH_DB: bindings.d1({
      id: '86700fa1-5910-4fa6-8f79-f6c544e8b206',
      name: 'openclaw-messenger-auth',
    }),
    MANAGER: bindings.worker({ worker: 'openclaw-messenger-manager' }),
    APP_ORIGIN: bindings.text(
      (process as NodeJS.Process).env.APP_ORIGIN ??
        'https://openclaw-messenger.pages.dev',
    ),
    APP_USERNAME: bindings.text(
      (process as NodeJS.Process).env.APP_USERNAME ?? 'admin',
    ),
    APP_PASSWORD_HASH: bindings.secret(),
    SESSION_TTL_SECONDS: bindings.text('86400'),
  },
});
export const manager = defineWorker({
  name: 'openclaw-messenger-manager',
  entrypoint: './src/manager/worker.ts',
  compatibilityDate: '2026-10-22',
  compatibilityFlags: ['nodejs_compat'],
  workersDev: false,
  previewUrls: false,
  observability: telemetry,
  exports: {
    ConversationManager: exports.durableObject({ storage: 'sqlite' }),
  },
  env: {
    BACKEND: bindings.worker({ worker: 'openclaw-messenger-backend' }),
    MANAGERS: bindings.durableObject({
      worker: 'openclaw-messenger-manager',
      exportName: 'ConversationManager',
    }),
    APP_ORIGIN: bindings.text(
      (process as NodeJS.Process).env.APP_ORIGIN ??
        'https://openclaw-messenger.pages.dev',
    ),
    MANAGER_ID: bindings.text('primary'),
  },
});
export const facade = defineWorker({
  name: 'openclaw-messenger-facade-local',
  entrypoint: './src/facade.ts',
  compatibilityDate: '2026-10-22',
  workersDev: false,
  previewUrls: false,
  observability: telemetry,
  env: {
    BACKEND: bindings.worker({ worker: 'openclaw-messenger-backend' }),
    MANAGER: bindings.worker({ worker: 'openclaw-messenger-manager' }),
  },
});
