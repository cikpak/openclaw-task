import { filesRoute } from './files.mjs';
import { createServer } from 'node:http';
import { getHeapStatistics } from 'node:v8';
import { createHash, timingSafeEqual } from 'node:crypto';
export function send(response, code, value) {
  response.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > Math.floor(getHeapStatistics().heap_size_limit / 8))
      throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function serve(bootId, jobs, status) {
  const secret = createHash('sha256')
    .update(`Bearer ${process.env.HELPER_TOKEN}`)
    .digest();
  const helper = createServer(async (request, response) => {
    const supplied = createHash('sha256')
      .update(request.headers.authorization ?? '')
      .digest();
    if (!timingSafeEqual(secret, supplied))
      return send(response, 401, { error: 'Unauthorized' });
    try {
      if (request.method === 'GET' && request.url === '/health')
        return send(response, 200, status());
      if (request.method === 'POST' && request.url?.startsWith('/files/')) {
        if (
          request.url === '/files/handoff' &&
          status().gatewayState !== 'running'
        )
          return send(response, 409, {
            error: 'File handoff requires a usable engine',
          });
        const result = await filesRoute(request, response, await body(request));
        if (result?.streamed) return;
        if (result) return send(response, 200, result.value);
      }
      const match = /^\/jobs\/([A-Za-z0-9_-]{1,80})(\/cancel)?$/.exec(
        request.url ?? '',
      );
      if (match && request.method === 'GET' && !match[2]) {
        const job = jobs.get(match[1]);
        return send(
          response,
          job ? 200 : 404,
          job ?? { error: 'Unknown operation' },
        );
      }
      if (match && request.method === 'POST' && match[2]) {
        const data = await body(request);
        if (data.bootId !== bootId)
          return send(response, 409, { error: 'Stale boot' });
        const job = jobs.cancel(match[1]);
        return send(
          response,
          job ? 202 : 404,
          job ?? { error: 'Unknown operation' },
        );
      }
      if (request.method === 'POST' && request.url === '/jobs') {
        const result = jobs.start(await body(request));
        return send(response, result.code, result.value);
      }
      send(response, 404, { error: 'Unknown endpoint' });
    } catch {
      if (!response.headersSent)
        send(response, 400, { error: 'Invalid helper request' });
    }
  });
  helper.requestTimeout = 5000;
  helper.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    helper.once('error', reject);
    helper.listen(8787, '0.0.0.0', resolve);
  });
  return helper;
}
