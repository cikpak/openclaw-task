import type { ProblemDetails } from '@messenger/contracts';
import { problemSchema } from './schemas.js';

export class ApplicationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class AuthenticationError extends ApplicationError {
  constructor() {
    super(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
  }
}
export class ValidationError extends ApplicationError {
  constructor(message = 'Check the submitted values.') {
    super(400, 'INVALID_REQUEST', message);
  }
}
export class ConflictError extends ApplicationError {
  constructor(
    code = 'CONFLICT',
    message = 'This operation conflicts with the current state.',
  ) {
    super(409, code, message);
  }
}
export class NotFoundError extends ApplicationError {
  constructor() {
    super(404, 'NOT_FOUND', 'The requested resource was not found.');
  }
}
export class GatewayUnavailableError extends ApplicationError {
  constructor() {
    super(
      503,
      'GATEWAY_UNAVAILABLE',
      'OpenClaw is unavailable. Your accepted work is retained.',
    );
  }
}
export class OutboundContractError extends ApplicationError {
  constructor() {
    super(
      500,
      'OUTBOUND_CONTRACT_INVALID',
      'Conversation state could not be delivered. Reconnect to refresh your retained work.',
    );
  }
}
export function toProblem(
  error: unknown,
  correlationId: string,
): ProblemDetails {
  const known = error instanceof ApplicationError;
  const status = known ? error.status : 500;
  const problem = problemSchema.safeParse({
    type: 'about:blank',
    title: status >= 500 ? 'Service error' : 'Request could not be completed',
    status,
    detail: known ? error.message : 'An unexpected error occurred.',
    code: known ? error.code : 'INTERNAL_ERROR',
    correlationId,
  });
  if (problem.success) return problem.data;
  // Error reporting must not throw recursively or expose malformed internal values.
  return {
    type: 'about:blank',
    title: 'Service error',
    status: 500,
    detail: 'An unexpected error occurred.',
    code: 'INTERNAL_ERROR',
    correlationId,
  };
}
