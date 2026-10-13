import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, Buffer.from(salt, 'hex'), 64)) as Buffer;
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [, salt, hex] = stored.split('$');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = (await derive(
    password,
    Buffer.from(salt, 'hex'),
    expected.length,
  )) as Buffer;
  return timingSafeEqual(actual, expected);
}
