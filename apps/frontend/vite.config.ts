import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: Object.fromEntries(
      [
        '/api',
        '/ws',
        '/downloads',
        ...(process.env.CLOUDFLARE_ACCEPTANCE === '1' ? ['/__acceptance'] : []),
      ].map((path) => [
        path,
        {
          target:
            process.env.CLOUDFLARE_PROXY_ORIGIN ?? 'http://127.0.0.1:8799',
          ws: path === '/ws',
        },
      ]),
    ),
  },
});
