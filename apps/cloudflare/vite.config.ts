import process from 'node:process';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { backend, manager } from './config/workers.ts';
import { localBoundary } from './config/local-boundary.ts';
import { localWorkers } from './config/local.ts';

export default defineConfig(({ mode }) => {
  const local = mode === 'development' || mode === 'acceptance';
  const workers = local ? localWorkers(mode) : { backend, manager };
  return {
    envDir: false,
    plugins: [
      ...(local
        ? [
            localBoundary(
              `openclaw-local-${(process as NodeJS.Process).env.CLOUDFLARE_WORKSPACE_ID}-recovery`,
            ),
          ]
        : []),
      cloudflare({
        ...(local || mode === 'production'
          ? {
              auxiliaryWorkers: [
                { config: workers.backend },
                {
                  config: local
                    ? {
                        ...workers.manager,
                        exports: {
                          ConversationManager: {
                            type: 'durable-object',
                            storage: 'sqlite',
                            container: localWorkers(mode).container.name,
                          },
                        },
                      }
                    : {
                        ...manager,
                        exports: {
                          ConversationManager: {
                            type: 'durable-object',
                            storage: 'sqlite',
                          },
                        },
                      },
                },
              ],
            }
          : {}),
        persistState: {
          path:
            (process as NodeJS.Process).env.CLOUDFLARE_STATE_DIR ??
            '../../.context/cloudflare-local',
        },
        inspectorPort: false,
      }),
    ],
    server: {
      host: '0.0.0.0',
      allowedHosts: ['host.docker.internal'],
      port: Number((process as NodeJS.Process).env.CLOUDFLARE_PORT ?? 8799),
      strictPort: true,
    },
  };
});
