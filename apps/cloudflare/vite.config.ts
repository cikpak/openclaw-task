import process from 'node:process';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { backend, manager } from './config/workers.ts';

export default defineConfig(({ mode }) => ({
  plugins: [
    cloudflare({
      ...(mode === 'backend' ||
      mode === 'backend-bootstrap' ||
      mode === 'manager'
        ? {}
        : {
            auxiliaryWorkers: [
              { config: backend },
              {
                config: {
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
          }),
      persistState: { path: '../../.context/cloudflare-local' },
      inspectorPort: false,
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: Number((process as NodeJS.Process).env.CLOUDFLARE_PORT ?? 8799),
    strictPort: true,
  },
}));
