import { consumeDownload, issueDownload } from './downloads.js';
import { checkGrant, renewGrant } from './grants.js';
import { body, fail, field, json } from './http.js';
import { consumeConnectionTicket } from './tickets.js';
import type { BackendEnv } from './types.js';

const paths = new Set([
  '/internal/auth/consume',
  '/internal/auth/renew',
  '/internal/auth/check',
  '/internal/downloads/issue',
  '/internal/downloads/consume',
]);

export async function internalRequest(
  env: BackendEnv,
  request: Request,
  path: string,
): Promise<Response> {
  if (!paths.has(path)) fail(404, 'NOT_FOUND', 'Route not found.');
  if (request.method !== 'POST')
    fail(405, 'METHOD_NOT_ALLOWED', 'POST is required.');
  const data = await body(request);
  const managerId = field(data, 'managerId');
  switch (path) {
    case '/internal/auth/consume':
      return json({
        grant: await consumeConnectionTicket(
          env,
          field(data, 'ticket'),
          field(data, 'sessionToken'),
          managerId,
          field(data, 'origin', 2048),
        ),
      });
    case '/internal/auth/check':
      return json({
        grant: await checkGrant(env, field(data, 'grantId'), managerId),
      });
    case '/internal/auth/renew':
      return json({
        grant: await renewGrant(env, field(data, 'grantId'), managerId),
      });
    case '/internal/downloads/issue':
      return json(
        await issueDownload(
          env,
          field(data, 'grantId'),
          managerId,
          field(data, 'fileId'),
        ),
      );
    case '/internal/downloads/consume':
      return json(
        await consumeDownload(
          env,
          field(data, 'ticket'),
          field(data, 'sessionToken'),
          managerId,
        ),
      );
    default:
      return fail(404, 'NOT_FOUND', 'Route not found.');
  }
}
