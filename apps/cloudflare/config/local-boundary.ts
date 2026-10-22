import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function localRequestAllowed(
  request: IncomingMessage,
  bucket: string,
  upgrade = false,
): boolean {
  const peer = loopback.has(request.socket.remoteAddress ?? '');
  const raw = request.url ?? '';
  if (!raw.startsWith('/')) return false;
  const path = raw.split('?')[0]!;
  let url: URL;
  try {
    url = new URL(raw, 'http://local');
  } catch {
    return false;
  }
  let decoded = path,
    control = false;
  try {
    for (let i = 0; i < 5; i++) {
      control ||= new URL(decoded, 'http://local').pathname.startsWith(
        '/cdn-cgi/',
      );
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      if (i === 4) return false;
      decoded = next;
    }
  } catch {
    return false;
  }
  if (upgrade) return peer && !control;
  if (!control) return peer;
  // All native development control APIs stay unavailable, including to Docker.
  if (
    !['GET', 'PUT'].includes(request.method ?? '') ||
    path !== url.pathname ||
    !/^[A-Za-z0-9_./-]+$/.test(path) ||
    path.includes('//') ||
    path.split('/').some((part) => part === '.' || part === '..')
  )
    return false;
  if (!path.startsWith(`/cdn-cgi/local/r2/s3/${bucket}/`) || path.endsWith('/'))
    return false;
  return (
    url.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256' &&
    /^[a-f0-9]{64}$/.test(url.searchParams.get('X-Amz-Signature') ?? '') &&
    !!url.searchParams.get('X-Amz-Credential')
  );
}
export function localBoundary(bucket: string): Plugin {
  return {
    name: 'messenger-local-boundary',
    enforce: 'pre',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (localRequestAllowed(request, bucket)) return next();
        response.writeHead(403, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end('{"code":"LOCAL_ACCESS_DENIED"}');
      });
      return () => {
        const http = server.httpServer;
        if (!http) return;
        type Upgrade = (
          request: IncomingMessage,
          socket: Duplex,
          head: Buffer,
        ) => void;
        // Pinned Vite installs HMR before configureServer; Cloudflare installs
        // its listener inside configureServer. Consolidate after every hook.
        const listeners = http.rawListeners('upgrade') as Upgrade[];
        http.removeAllListeners('upgrade');
        http.on(
          'upgrade',
          (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            if (!localRequestAllowed(request, bucket, true)) {
              socket.end(
                'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
              );
              return;
            }
            for (const listener of listeners)
              listener.call(http, request, socket, head);
          },
        );
      };
    },
  };
}
