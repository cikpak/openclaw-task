import { parseConfig } from './config.js';
import { buildServer } from './server.js';
const config = parseConfig(process.env);
const { app } = await buildServer({ config, logger: true });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close();
  });
await app.listen({ host: config.host, port: config.port });
