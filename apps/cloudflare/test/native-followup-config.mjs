export async function providerConfig(control, providerUrl) {
  const config = await control.node(
    `import {defaults} from '/opt/messenger-helper/configuration.mjs';emit(defaults());`,
  );
  config.agents.defaults.model = { primary: 'mock/test-model' };
  config.models = {
    mode: 'merge',
    providers: {
      mock: {
        baseUrl: providerUrl,
        apiKey: 'test-only-followup',
        api: 'openai-completions',
        models: [
          {
            id: 'test-model',
            name: 'Followup proof',
            reasoning: false,
            input: ['text'],
            contextWindow: 32768,
            maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  return config;
}
