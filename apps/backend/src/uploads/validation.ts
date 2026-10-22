import { ApplicationError, ValidationError } from '../errors.js';

export const FILE_LIMIT = 5 * 1024 * 1024;
export const MESSAGE_LIMIT = 10 * 1024 * 1024;
export const DEFAULT_GATEWAY_PAYLOAD = 25 * 1024 * 1024;
export const ENVELOPE_RESERVE = 262144;
export const UPLOAD_LIFETIME = 60 * 60 * 1000;
const allowed = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
  'application/pdf',
]);

export function safeFilename(name: string): string {
  const cleaned = name
    .split(/[\\/]/)
    .at(-1)
    ?.split('')
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
    .join('')
    .trim();
  return Array.from(cleaned || 'attachment')
    .slice(0, 150)
    .join('');
}
export function validateFile(bytes: Uint8Array, declared: string): string {
  if (!bytes.length) throw new ValidationError('The attached file is empty.');
  if (bytes.length > FILE_LIMIT)
    throw new ApplicationError(
      413,
      'UPLOAD_TOO_LARGE',
      'Each attachment must be at most five MiB.',
    );
  const mime = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!allowed.has(mime))
    throw new ApplicationError(
      415,
      'UNSUPPORTED_ATTACHMENT',
      'Attach PNG, JPEG, WebP, UTF-8 text, Markdown, or PDF.',
    );
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every(
    (byte, index) => bytes[index] === byte,
  );
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  const pdf = /^%PDF-1\.[0-9]|^%PDF-2\.0/.test(
    String.fromCharCode(...bytes.subarray(0, 8)),
  );
  if (
    (mime === 'image/png' && !png) ||
    (mime === 'image/jpeg' && !jpeg) ||
    (mime === 'image/webp' && !webp) ||
    (mime === 'application/pdf' && !pdf)
  )
    throw new ValidationError('The file contents do not match its type.');
  if (mime.startsWith('text/')) {
    if (png || jpeg || webp || pdf || bytes.includes(0))
      throw new ValidationError('Attach a valid UTF-8 text file.');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ValidationError('Attach a valid UTF-8 text file.');
    }
  }
  return mime;
}
export function validateMessageSize(
  sizes: number[],
  maxPayload = DEFAULT_GATEWAY_PAYLOAD,
): void {
  if (sizes.length > 5)
    throw new ValidationError('Attach at most five files per message.');
  if (sizes.reduce((sum, size) => sum + size, 0) > MESSAGE_LIMIT)
    throw new ApplicationError(
      413,
      'ATTACHMENTS_TOO_LARGE',
      'Message attachments must total at most ten MiB.',
    );
  if (
    sizes.reduce(
      (sum, size) => sum + 4 * Math.ceil(size / 3),
      ENVELOPE_RESERVE,
    ) > maxPayload
  )
    throw new ApplicationError(
      413,
      'GATEWAY_PAYLOAD_LIMIT',
      'These attachments exceed the current OpenClaw transfer limit.',
    );
}
