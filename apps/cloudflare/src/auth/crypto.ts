import { verifyPassword } from '../../../backend/src/auth/password.js';

export function opaqueToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export async function passwordMatches(
  password: string,
  stored: string,
): Promise<boolean> {
  // Reject malformed hashes before scrypt, including zero-byte and oversized output.
  if (!/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored)) return false;
  return verifyPassword(password, stored);
}
