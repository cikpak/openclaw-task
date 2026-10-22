import process from 'node:process';
import { bindings, defineContainer, exports } from 'cf/config';
import { backend, facade, manager } from './workers.ts';

export function localWorkers(mode: string) {
  const env = (process as NodeJS.Process).env;
  const id = env.CLOUDFLARE_WORKSPACE_ID;
  if (!id || !/^[a-f0-9]{12}$/.test(id))
    throw new Error('Start local development through pnpm dev.');
  const prefix = `openclaw-local-${id}`;
  const origin = env.APP_ORIGIN!;
  const credentials = {
    accessKeyId: env.LOCAL_R2_ACCESS_KEY_ID!,
    secretAccessKey: env.LOCAL_R2_SECRET_ACCESS_KEY!,
  };
  if (!origin || !credentials.accessKeyId || !credentials.secretAccessKey)
    throw new Error('Local environment is incomplete.');
  const test = mode === 'acceptance';
  const container = defineContainer({
    name: `${prefix}-engine`,
    schedulingPolicy: 'durable-object',
    images: {
      base: test
        ? {
            dockerfile: '../../test/acceptance/Dockerfile',
            buildContext: '../..',
          }
        : { dockerfile: './container/Dockerfile' },
    },
  });
  const localBackend = {
    ...backend,
    name: `${prefix}-backend`,
    entrypoint: test
      ? './test/acceptance-backend.ts'
      : './src/local-backend.ts',
    env: {
      ...backend.env,
      AUTH_DB: bindings.d1({ name: `${prefix}-auth` }),
      MANAGER: bindings.worker({ worker: `${prefix}-manager` }),
      APP_ORIGIN: bindings.text(origin),
      APP_PASSWORD_HASH: bindings.text(env.APP_PASSWORD_HASH!),
    },
  };
  const localManager = {
    ...manager,
    name: `${prefix}-manager`,
    entrypoint: test ? './test/acceptance-worker.ts' : manager.entrypoint,
    exports: {
      ConversationManager: exports.durableObject({
        storage: 'sqlite',
        container,
      }),
    },
    env: {
      ...manager.env,
      ...(test ? { ACCEPTANCE_MODE: bindings.text('1') } : {}),
      BACKEND: bindings.worker({ worker: localBackend.name }),
      MANAGERS: bindings.durableObject({
        worker: `${prefix}-manager`,
        exportName: 'ConversationManager',
      }),
      APP_ORIGIN: bindings.text(origin),
      ENGINE_IDLE_SECONDS: bindings.text(env.ENGINE_IDLE_SECONDS ?? '60'),
      RECOVERY_BUCKET: bindings.r2({
        name: `${prefix}-recovery`,
        dev: { experimentalS3Credentials: credentials },
      }),
      R2_BUCKET_NAME: bindings.text(`${prefix}-recovery`),
      R2_ORIGIN: bindings.text(
        `http://host.docker.internal:${env.CLOUDFLARE_PORT}/cdn-cgi/local/r2/s3`,
      ),
      LOCAL_R2_EMULATOR: bindings.text('1'),
      R2_ACCESS_KEY_ID: bindings.text(credentials.accessKeyId),
      R2_SECRET_ACCESS_KEY: bindings.text(credentials.secretAccessKey),
      ...(env.OPENAI_API_KEY
        ? { OPENAI_API_KEY: bindings.text(env.OPENAI_API_KEY) }
        : {}),
      ...(env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: bindings.text(env.ANTHROPIC_API_KEY) }
        : {}),
    },
  };
  return {
    container,
    backend: localBackend,
    manager: localManager,
    facade: {
      ...facade,
      name: `${prefix}-facade`,
      triggers: [{ type: 'fetch' as const, pattern: 'host.docker.internal/*' }],
      entrypoint: test ? './test/acceptance-facade.ts' : facade.entrypoint,
      env: {
        BACKEND: bindings.worker({ worker: localBackend.name }),
        MANAGER: bindings.worker({ worker: localManager.name }),
      },
    },
  };
}
