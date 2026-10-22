/** Shared by the local Worker harness and thin production Pages Functions. */
export interface FacadeBindings {
  BACKEND: Fetcher;
  MANAGER: Fetcher;
}
const authPaths = new Set([
  '/api/login',
  '/api/logout',
  '/api/session',
  '/api/connection-tickets',
]);
export async function routeDynamic(
  request: Request,
  env: FacadeBindings,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  let route = 'unknown';
  let response: Response;
  const correlationId = crypto.randomUUID();
  try {
    // No public forwarding of private authorization/lifecycle endpoints.
    if (authPaths.has(path)) {
      route = 'authentication';
      response = await env.BACKEND.fetch(request);
    } else if (
      path === '/ws/conversation' ||
      /^\/downloads\/[^/]+$/.test(path)
    ) {
      route = path === '/ws/conversation' ? 'conversation' : 'download';
      response = await env.MANAGER.fetch(request);
    } else
      response = Response.json(
        { code: 'NOT_FOUND', detail: 'The route does not exist.' },
        { status: 404 },
      );
  } catch {
    response = Response.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        detail: 'The service is temporarily unavailable.',
      },
      { status: 503 },
    );
  }
  // Never include Request, URL, cookies, headers, supplied IDs, exceptions or bodies.
  console.info(
    JSON.stringify({ route, correlationId, status: response.status }),
  );
  return response;
}
export default {
  fetch: routeDynamic,
} satisfies ExportedHandler<FacadeBindings>;
