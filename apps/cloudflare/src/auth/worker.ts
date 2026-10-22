import { AuthError, fail, json } from './http.js';
import { internalRequest } from './internal.js';
import { getSession, login, logout } from './sessions.js';
import { issueConnectionTicket } from './tickets.js';
import type { BackendEnv } from './types.js';

async function route(request: Request, env: BackendEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  // This Worker has no public route/workers.dev endpoint. Only trusted service
  // bindings reach these private methods; Pages forwards an explicit public list.
  if (path.startsWith('/internal/')) return internalRequest(env, request, path);
  if (
    ![
      '/api/login',
      '/api/logout',
      '/api/session',
      '/api/connection-tickets',
    ].includes(path)
  )
    fail(404, 'NOT_FOUND', 'Route not found.');
  if (url.search)
    fail(400, 'INVALID_REQUEST', 'Query parameters are not supported.');
  if (
    request.method !== 'GET' &&
    request.headers.get('Origin') !== env.APP_ORIGIN
  )
    fail(403, 'ORIGIN_REJECTED', 'Request origin is not allowed.');
  if (path === '/api/session' && request.method === 'GET')
    return getSession(env, request);
  if (
    (path === '/api/login' || path === '/api/session') &&
    request.method === 'POST'
  )
    return login(env, request);
  if (
    (path === '/api/logout' && request.method === 'POST') ||
    (path === '/api/session' && request.method === 'DELETE')
  )
    return logout(env, request);
  if (path === '/api/connection-tickets' && request.method === 'POST')
    return issueConnectionTicket(env, request);
  return fail(405, 'METHOD_NOT_ALLOWED', 'Request method is not allowed.');
}

export default {
  async fetch(request: Request, env: BackendEnv): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof AuthError)
        return json(
          { code: error.code, detail: error.message },
          error.status,
          error.headers,
        );
      // Never serialize exceptions, requests, cookies, URLs, or SQL bindings.
      return json(
        {
          code: 'AUTH_UNAVAILABLE',
          detail: 'Authentication service is temporarily unavailable.',
        },
        503,
      );
    }
  },
};
