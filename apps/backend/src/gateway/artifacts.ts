import { z } from 'zod';
import type { Artifact } from '@messenger/contracts';
import { ApplicationError, NotFoundError } from '../errors.js';
import type { GatewayMapping } from './types.js';
import { FILE_LIMIT, safeFilename } from '../uploads/validation.js';

export const upstreamArtifactSchema = z.object({
  id: z.string().min(1).max(2048),
  title: z.string().optional(),
  mimeType: z
    .string()
    .max(100)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i)
    .optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sessionKey: z.string(),
  download: z.object({ mode: z.enum(['bytes', 'url', 'unsupported']) }),
});
function publicArtifact(
  value: z.infer<typeof upstreamArtifactSchema>,
): Artifact {
  return {
    id: Buffer.from(value.id).toString('base64url'),
    name: safeFilename(value.title ?? 'artifact'),
    mimeType: value.mimeType ?? 'application/octet-stream',
    sizeBytes: value.sizeBytes ?? 0,
  };
}
export function projectArtifacts(
  value: unknown,
  mapping: GatewayMapping,
): Artifact[] {
  const data = z
    .object({ artifacts: z.array(upstreamArtifactSchema).max(1000) })
    .parse(value);
  return data.artifacts
    .filter(
      (item) =>
        item.sessionKey === mapping.sessionKey &&
        item.download.mode !== 'unsupported',
    )
    .slice(0, 100)
    .map(publicArtifact);
}
export function decodeArtifactId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,2732}$/.test(id)) throw new NotFoundError();
  const bytes = Buffer.from(id, 'base64url');
  if (bytes.toString('base64url') !== id) throw new NotFoundError();
  const decoded = bytes.toString('utf8');
  if (!decoded || Buffer.from(decoded).toString('base64url') !== id)
    throw new NotFoundError();
  return decoded;
}
export function projectArtifactDownload(
  value: unknown,
  mapping: GatewayMapping,
  upstreamId: string,
): { artifact: Artifact; bytes: Buffer } {
  const data = z
    .object({
      artifact: upstreamArtifactSchema,
      encoding: z.string().optional(),
      data: z
        .string()
        .max(4 * Math.ceil(FILE_LIMIT / 3))
        .optional(),
    })
    .parse(value);
  if (
    data.artifact.id !== upstreamId ||
    data.artifact.sessionKey !== mapping.sessionKey
  )
    throw new NotFoundError();
  if (
    data.artifact.download.mode !== 'bytes' ||
    data.encoding !== 'base64' ||
    data.data === undefined
  )
    throw new ApplicationError(
      422,
      'ARTIFACT_DOWNLOAD_UNSUPPORTED',
      'OpenClaw cannot safely transfer this artifact.',
    );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data.data,
    )
  )
    throw new ApplicationError(
      502,
      'ARTIFACT_INVALID',
      'OpenClaw returned an invalid artifact.',
    );
  const bytes = Buffer.from(data.data, 'base64');
  if (
    bytes.length > FILE_LIMIT ||
    (data.artifact.sizeBytes !== undefined &&
      data.artifact.sizeBytes !== bytes.length)
  )
    throw new ApplicationError(
      502,
      'ARTIFACT_INVALID',
      'OpenClaw returned an invalid artifact.',
    );
  return {
    artifact: { ...publicArtifact(data.artifact), sizeBytes: bytes.length },
    bytes,
  };
}
