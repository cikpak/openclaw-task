import { record } from './validation';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function request(
  path: string,
  options: RequestInit = {},
): Promise<{ data: unknown; etag: string | null }> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body === undefined ||
      options.body === null ||
      options.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  });
  const data: unknown =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      record(data) && typeof data.detail === 'string'
        ? data.detail
        : 'The request could not be completed. Please try again.',
      response.status,
      record(data) && typeof data.code === 'string'
        ? data.code
        : 'REQUEST_FAILED',
    );
  return { data, etag: response.headers.get('ETag') };
}
export const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
export const resourceTag = (version: number) => `"${version}"`;
export const commandId = () => crypto.randomUUID();
