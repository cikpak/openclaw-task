import { z } from 'zod';
import { problemSchema } from '../schemas.js';
import { FILE_LIMIT } from './validation.js';

const filenameSchema = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (name) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      Array.from(name).every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
const mimeSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i);
export const uploadResponseSchema = z.strictObject({
  uploadId: z.uuid(),
  name: filenameSchema,
  mimeType: z.enum([
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain',
    'text/markdown',
    'application/pdf',
  ]),
  size: z.number().int().positive().max(FILE_LIMIT),
});
export const mediaArtifactSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(2732)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: filenameSchema,
  mimeType: mimeSchema,
  sizeBytes: z.number().int().nonnegative(),
  sourcePath: z
    .string()
    .min(1)
    .max(1024)
    .refine((path) => {
      const segments = path.split('/');
      return (
        segments.length <= 8 &&
        !path.includes('\\') &&
        segments.every(
          (segment) =>
            !!segment &&
            !segment.startsWith('.') &&
            Array.from(segment).every(
              (character) =>
                character.charCodeAt(0) >= 32 &&
                character.charCodeAt(0) !== 127,
            ),
        )
      );
    })
    .optional(),
});
export const artifactCatalogResponseSchema = z.strictObject({
  artifacts: z.array(mediaArtifactSchema).max(100),
});
export const sharedFilesResponseSchema = z.strictObject({
  files: z.array(uploadResponseSchema).max(100),
});
export const noContentSchema = z.undefined();
export const mediaErrorResponses = {
  '4xx': problemSchema.extend({ status: z.number().int().min(400).max(499) }),
  '5xx': problemSchema.extend({ status: z.number().int().min(500).max(599) }),
};
export const uploadResponseHeadersSchema = z.strictObject({
  location: z.string().regex(/^\/api\/uploads\/[a-f0-9-]{36}$/),
});
export const downloadResponseHeadersSchema = z.strictObject({
  'Content-Disposition': z
    .string()
    .regex(
      /^attachment; filename="artifact"; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/,
    ),
  'X-Content-Type-Options': z.literal('nosniff'),
  'Cache-Control': z.literal('private, no-store'),
  'Content-Type': z.literal('application/octet-stream'),
  'Content-Length': z.number().int().nonnegative().max(FILE_LIMIT),
});

/** Invalid service output is an internal fault, never a caller-validation error or a source-data leak. */
export function validateMediaResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid media service response.');
  return parsed.data;
}
