/* Fastify hooks must return promises. */
/* eslint-disable @typescript-eslint/require-await */
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { ApplicationError, ValidationError, toProblem } from '../errors.js';
import type { LegacyApp } from './application.js';

export function registerErrors(app: LegacyApp, origin: string) {
  app.addHook('onRequest', async (request) => {
    if (
      ['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method) &&
      request.headers.origin !== origin
    )
      throw new ApplicationError(
        403,
        'ORIGIN_REJECTED',
        'The request origin is not allowed.',
      );
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/'))
      request.log = request.log.child({ correlationId: request.id });
  });
  app.setErrorHandler((error, request, reply) => {
    const statusError = error as { statusCode?: number; code?: string };
    // Zod failures in storage/upstream projections are server faults, not invalid client input.
    const validation =
      statusError.code === 'FST_ERR_VALIDATION' &&
      hasZodFastifySchemaValidationErrors(error);
    const parserErrors: Record<
      string,
      { status: number; code: string; detail: string }
    > = {
      FST_ERR_CTP_INVALID_JSON_BODY: {
        status: 400,
        code: 'INVALID_JSON',
        detail: 'The request body must contain valid JSON.',
      },
      FST_ERR_CTP_EMPTY_JSON_BODY: {
        status: 400,
        code: 'EMPTY_JSON_BODY',
        detail: 'Provide a JSON body or omit its content type.',
      },
      FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
        status: 400,
        code: 'INVALID_CONTENT_LENGTH',
        detail: 'The request body length is invalid.',
      },
      FST_ERR_CTP_BODY_TOO_LARGE: {
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        detail: 'The request body exceeds the permitted size.',
      },
      FST_ERR_CTP_INVALID_MEDIA_TYPE: {
        status: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        detail: 'The request content type is not supported.',
      },
    };
    const parser = statusError.code
      ? parserErrors[statusError.code]
      : undefined;
    const safe = validation
      ? new ValidationError()
      : statusError.statusCode === 429
        ? new ApplicationError(
            429,
            'RATE_LIMITED',
            'Too many attempts. Try again shortly.',
          )
        : parser
          ? new ApplicationError(parser.status, parser.code, parser.detail)
          : error;
    const problem = toProblem(safe, request.id);
    if (problem.status === 500)
      request.log.error(
        { errorClass: error instanceof Error ? error.name : 'Unknown' },
        'Request failed',
      );
    void reply
      .code(problem.status)
      .type('application/problem+json')
      .send(problem);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type('application/problem+json')
      .send(
        toProblem(
          new ApplicationError(
            404,
            'NOT_FOUND',
            'The requested resource was not found.',
          ),
          request.id,
        ),
      );
  });
}
