import process from 'node:process';
import { bindings, defineWorker, defineContainer, exports } from 'cf/config';

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
export const engineContainer = defineContainer({
  name: 'openclaw-messenger-engine',
  schedulingPolicy: 'durable-object',
  images: { base: { dockerfile: './container/Dockerfile' } },
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
    ConversationManager: exports.durableObject({
      storage: 'sqlite',
      container: engineContainer,
    }),
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
    ENGINE_IDLE_SECONDS: bindings.text('60'),
    DEFAULT_MODEL: bindings.text(
      (process as NodeJS.Process).env.DEFAULT_MODEL ?? 'openai/gpt-5',
    ),
    RECOVERY_BUCKET: bindings.r2({ name: 'openclaw-messenger-production' }),
    R2_BUCKET_NAME: bindings.text('openclaw-messenger-production'),
    R2_ORIGIN: bindings.text(
      'https://65cabd080cdf7a36f76d0e884752c249.r2.cloudflarestorage.com',
    ),
    R2_ACCESS_KEY_ID: bindings.secret(),
    R2_SECRET_ACCESS_KEY: bindings.secret(),
    OPENAI_API_KEY: bindings.secret(),
    ANTHROPIC_API_KEY: bindings.secret(),
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
