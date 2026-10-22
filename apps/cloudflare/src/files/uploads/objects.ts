import { AwsClient } from 'aws4fetch';
import { validateFile } from '../../../../backend/src/uploads/validation.js';
import { ApplicationError } from '../../../../backend/src/errors.js';
import type { ManagerEnv } from '../../manager/types.js';
import type { UploadChunk, UploadRecord } from './types.js';
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export class UploadObjects {
  constructor(
    private readonly env: ManagerEnv,
    private readonly secrets: () => Promise<readonly string[]> = () =>
      Promise.resolve([]),
  ) {}
  get bucket(): R2Bucket {
    if (!this.env.RECOVERY_BUCKET)
      throw new ApplicationError(
        503,
        'UPLOAD_STORAGE_UNAVAILABLE',
        'Attachment storage is temporarily unavailable.',
      );
    return this.env.RECOVERY_BUCKET;
  }
  async assemble(row: UploadRecord, chunks: UploadChunk[]): Promise<string> {
    // Browser input is explicitly capped at five MiB; engine preservation never uses this path.
    const bytes = new Uint8Array(row.size);
    let offset = 0;
    for (const chunk of chunks) {
      if (chunk.offset !== offset) throw new Error('Incomplete attachment');
      const object = await this.bucket.get(chunk.key);
      if (!object || object.size !== chunk.size)
        throw new Error('Attachment chunk unavailable');
      const data = new Uint8Array(await object.arrayBuffer());
      if ((await sha256(data)) !== chunk.sha256)
        throw new Error('Attachment chunk corrupted');
      bytes.set(data, offset);
      offset += data.length;
    }
    if (offset !== row.size) throw new Error('Incomplete attachment');
    validateFile(bytes, row.mimeType);
    const text = new TextDecoder().decode(bytes);
    if (
      (await this.secrets()).some(
        (secret) => secret.length > 0 && text.includes(secret),
      )
    )
      throw new ApplicationError(
        422,
        'UPLOAD_SENSITIVE_CONTENT',
        'This attachment cannot be shared. Remove confidential account information and attach it again.',
      );
    const digest = await sha256(bytes);
    const object = await this.bucket.put(row.key, bytes, {
      sha256: digest,
      httpMetadata: { contentType: row.mimeType },
    });
    if (!object || object.size !== row.size)
      throw new Error('Attachment storage incomplete');
    return digest;
  }
  async signedGet(row: UploadRecord): Promise<string> {
    const env = this.env;
    if (
      !env.R2_ORIGIN ||
      !env.R2_BUCKET_NAME ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    )
      throw new Error('Attachment signing unavailable');
    const origin = new URL(env.R2_ORIGIN);
    if (
      origin.protocol !== 'https:' ||
      !/^[a-f0-9]+\.r2\.cloudflarestorage\.com$/.test(origin.hostname) ||
      origin.origin !== env.R2_ORIGIN
    )
      throw new Error('Invalid attachment origin');
    const url = new URL(
      `/${env.R2_BUCKET_NAME}/${row.key.split('/').map(encodeURIComponent).join('/')}`,
      origin,
    );
    url.searchParams.set('X-Amz-Expires', '300');
    const client = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
      retries: 0,
    });
    return (
      await client.sign(url, {
        method: 'GET',
        aws: { signQuery: true, allHeaders: true },
      })
    ).url;
  }
}
