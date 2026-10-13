// Deterministic provider for real-Gateway acceptance only; never used by compose.yaml.
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { initialOpenClawConfig } from './bootstrap-policy.mjs';

const capacity = { active: 0, peak: 0, calls: 0 };
const provider = createServer((request, response) => {
  if (request.url === '/acceptance/stats') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ capacity }));
    return;
  }
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'test-model', object: 'model', owned_by: 'test' }],
      }),
    );
    return;
  }
  if (request.url !== '/v1/chat/completions') {
    response.writeHead(404);
    response.end();
    return;
  }
  let body = '';
  request.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > 16_777_216) request.destroy();
  });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const prompt = JSON.stringify(messages);
      const markers = [
        'TEXT_FIXTURE_TOKEN',
        'MARKDOWN_FIXTURE_TOKEN',
        'PDF_FIXTURE_TOKEN',
      ].filter((marker) => prompt.includes(marker));
      if (
        messages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === 'image_url'),
        )
      )
        markers.push('IMAGE_FIXTURE_RECEIVED');
      const latestUser = messages.findLastIndex(
        (message) => message.role === 'user',
      );
      const currentPrompt = JSON.stringify(messages[latestUser]?.content ?? '');
      const capacityMarker = currentPrompt.match(/CAPACITY_CHAT_\d+/u)?.[0];
      if (capacityMarker) markers.push(capacityMarker);
      const reply = currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE')
        ? 'Generated document ready. [Download generated document](documents/artifact-fixture.txt)'
        : currentPrompt.includes('MARKDOWN_STYLE_FIXTURE')
          ? '- **Chisinau Politechnical College:** Computer Science, June 2018.\n- **Step IT Academy:** Computer Science, December 2019.\n\n### Skills and tools\n\nCovers JavaScript/TypeScript, React, Vue, Next.js, HTML/CSS, Node.js, Python, SQL, MongoDB, APIs, microservices, and CI/CD. Also lists Git, AWS, Docker, deployment tools, design systems, UI/UX, OpenAI API, and agentic development.\n\nThe header includes a phone number, email address, and LinkedIn reference.\n\n**Overall:** It presents an engineer who combines product development and frontend leadership with substantial experience teaching others.'
          : `Real Gateway integration response.${markers.length ? ' ' + markers.join(' ') : ''}`;
      if (currentPrompt.includes('CAPACITY_RESPONSE_FIXTURE')) {
        capacity.active++;
        capacity.calls++;
        capacity.peak = Math.max(capacity.peak, capacity.active);
        response.once('close', () => {
          capacity.active--;
        });
      }
      const toolName = currentPrompt.includes('TOOL_READ_IMAGE_FIXTURE')
        ? 'read'
        : 'write';
      const tool = Array.isArray(payload.tools)
        ? payload.tools.find((entry) => entry.function?.name === toolName)
        : null;
      const callTool =
        (currentPrompt.includes('TOOL_WRITE_FIXTURE') ||
          currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE') ||
          currentPrompt.includes('TOOL_READ_IMAGE_FIXTURE')) &&
        tool &&
        !messages
          .slice(latestUser + 1)
          .some((message) => message.role === 'tool');
      const pathKey = tool?.function?.parameters?.properties?.path
        ? 'path'
        : 'file_path';
      const toolCall = {
        id: `call-fixture-${toolName}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify({
            [pathKey]:
              toolName === 'read'
                ? 'artifact-fixture.png'
                : currentPrompt.includes('TOOL_WRITE_DOC_FIXTURE')
                  ? 'documents/artifact-fixture.txt'
                  : 'artifact-fixture.txt',
            ...(toolName === 'write' ? { content: 'TOOL_FILE_TOKEN' } : {}),
          }),
        },
      };
      if (!payload.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'test-completion',
            object: 'chat.completion',
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: callTool ? null : reply,
                  ...(callTool ? { tool_calls: [toolCall] } : {}),
                },
                finish_reason: callTool ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 8,
              total_tokens: 18,
            },
          }),
        );
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      void (async () => {
        if (
          currentPrompt.includes('CAPACITY_RESPONSE_FIXTURE') ||
          currentPrompt.includes('RESTART_RESPONSE_FIXTURE')
        )
          await delay(45000);
        else if (currentPrompt.includes('LONG_RESPONSE_FIXTURE'))
          await delay(12000);
        else if (currentPrompt.includes('DELAY_RESPONSE_FIXTURE'))
          await delay(1500);
        if (callTool) {
          response.write(
            `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`,
          );
        }
        for (const text of callTool ? [] : (reply.match(/\S+\s*/gu) ?? [])) {
          response.write(
            `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'test-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
          );
          await delay(75);
        }
        response.write(
          `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }] })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      })().catch(() => response.destroy());
    } catch {
      response.writeHead(400);
      response.end();
    }
  });
});
provider.listen(18889, '127.0.0.1');
const config = initialOpenClawConfig('mock/test-model');
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 2048,
        },
      ],
    },
  },
};
await mkdir('/home/node/.openclaw', { recursive: true, mode: 0o700 });
try {
  await writeFile(
    '/home/node/.openclaw/openclaw.json',
    JSON.stringify(config),
    { flag: 'wx', mode: 0o600 },
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
await import('./openclaw-start.mjs');
