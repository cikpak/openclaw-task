import * as production from './configuration.production.mjs';
export {
  marker,
  auditConfig,
  audit,
  defaults,
} from './configuration.production.mjs';
/** Selected only by the acceptance Dockerfile, never copied into the production image. */
export async function initialize(input) {
  const config = input.config ?? production.defaults();
  config.agents.defaults.model = { primary: 'mock/test-model' };
  config.models = {
    mode: 'merge',
    providers: {
      mock: {
        baseUrl: 'http://127.0.0.1:18889/v1',
        apiKey: 'deterministic-local-provider',
        api: 'openai-completions',
        models: [
          {
            id: 'test-model',
            name: 'Integration model',
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 32768,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  return production.initialize({ ...input, config });
}
