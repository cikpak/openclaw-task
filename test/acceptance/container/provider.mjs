// Deterministic provider only in the explicitly selected acceptance image.
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { responsePlan } from './response.mjs';
import { recordProvider } from './provider-diagnostics.mjs';
const capacity = { active: 0, peak: 0, calls: 0 };
const diagnostics = [];
const provider = createServer((request, response) => {
  if (request.url === '/acceptance/stats') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ capacity, diagnostics }));
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
      const { payload, currentPrompt, reply, callTool, toolCall } =
        responsePlan(body, response, capacity);
      recordProvider(
        diagnostics,
        response,
        payload,
        currentPrompt,
        callTool,
        toolCall,
      );
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
          await delay(6000);
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
export function startProvider() {
  return new Promise((resolve) => provider.listen(18889, '127.0.0.1', resolve));
}
