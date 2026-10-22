import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { until } from './native-followup-fixture.mjs';

export async function provider() {
  const prefix = `/${randomUUID()}`;
  const calls = [];
  let verify = async () => {};
  const held = new Set([1]);
  const server = createServer(async (request, response) => {
    if (request.url !== `${prefix}/v1/chat/completions`) {
      response.writeHead(404);
      response.end();
      return;
    }
    let call;
    try {
      let body = '';
      for await (const bytes of request) {
        body += bytes.toString();
        assert.ok(body.length <= 2 * 1024 * 1024);
      }
      const payload = JSON.parse(body);
      call = { payload, response, finished: false, failed: false };
      calls.push(call);
      await verify(call, calls.length);
      const index = calls.indexOf(call) + 1;
      if (held.has(index))
        await until(
          () => !held.has(index) || response.destroyed,
          'release held provider',
        );
      if (response.destroyed) return;
      const content = `FOLLOWUP_IMAGE_REPLY_${calls.indexOf(call) + 1}`;
      if (payload.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish_reason) =>
          `data: ${JSON.stringify({ id: 'image-proof', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        response.write(chunk({ role: 'assistant', content }, null));
        response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'image-proof',
            object: 'chat.completion',
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
      call.finished = true;
    } catch (error) {
      if (call) call.failed = String(error);
      else calls.push({ failed: String(error), finished: false });
      if (response.destroyed) return;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((accept) => server.listen(0, '0.0.0.0', accept));
  return {
    url: `http://host.docker.internal:${server.address().port}${prefix}/v1`,
    calls,
    verify: (callback) => {
      verify = callback;
    },
    hold: (index) => held.add(index),
    release: (index = 1) => held.delete(index),
    close: () => {
      held.clear();
      server.closeAllConnections();
      return new Promise((accept) => server.close(accept));
    },
  };
}
