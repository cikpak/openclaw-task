import { COOKIE_NAME } from './types.js';

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}

export function json(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const safeHeaders = new Headers(headers);
  safeHeaders.set('Cache-Control', 'no-store');
  safeHeaders.set('X-Content-Type-Options', 'nosniff');
  return Response.json(value, { status, headers: safeHeaders });
}

export function fail(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): never {
  throw new AuthError(status, code, message, headers);
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get('Content-Type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    fail(415, 'INVALID_CONTENT_TYPE', 'JSON is required.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_REQUEST', 'A JSON object is required.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      fail(413, 'REQUEST_TOO_LARGE', 'Request is too large.');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, 'INVALID_REQUEST', 'A JSON object is required.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    fail(400, 'INVALID_REQUEST', 'A JSON object is required.');
  return parsed as Record<string, unknown>;
}

export function field(
  data: Record<string, unknown>,
  key: string,
  max = 256,
): string {
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    fail(400, 'INVALID_REQUEST', `Invalid ${key}.`);
  return value;
}

export function sessionToken(request: Request): string | null {
  const values = (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  // Ambiguous cookies must never select an attacker-controlled session.
  return values.length === 1 ? values[0]!.slice(COOKIE_NAME.length + 1) : null;
}

export function sessionCookie(token: string, ttl: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttl}`;
}
