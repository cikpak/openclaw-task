import { abortable } from './bounded.js';
import { recoveryObjectUrl } from './origin.js';
import { base64 } from './encoding.js';
import { AwsClient } from 'aws4fetch';
import type { ManagerEnv } from '../../manager/types.js';
import {
  recoveryObjects,
  type RecoveryDescriptor,
  type TransferGrant,
} from './types.js';
import type { RecoveryCheckpoint } from '../lifecycle/types.js';

/** Exact object/method grants never expose account credentials to the container. */
export class RecoveryObjects {
  constructor(private readonly env: ManagerEnv) {}
  descriptor(checkpoint: RecoveryCheckpoint): RecoveryDescriptor {
    const value = checkpoint.descriptor;
    if (
      !value ||
      value.version !== 1 ||
      value.checkpointId !== checkpoint.generation ||
      !Array.isArray(value.files)
    )
      throw new Error('Invalid recovery reference');
    const result = value as unknown as RecoveryDescriptor;
    if (
      result.manifest.key !== checkpoint.manifestKey ||
      result.manifest.sha256 !== checkpoint.manifestSha256
    )
      throw new Error('Recovery reference mismatch');
    for (const object of recoveryObjects(result)) {
      if (
        !/^(?:recovery\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_./-]+|files\/(?:[a-zA-Z0-9_-]+\/)?[a-f0-9]{64})$/.test(
          object.key,
        ) ||
        object.key.split('/').includes('..') ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        !/^[a-f0-9]{64}$/.test(object.sha256) ||
        !/^[A-Za-z0-9+/]{22}==$/.test(object.md5)
      )
        throw new Error('Invalid recovery object');
    }
    return result;
  }
  async grants(
    descriptor: RecoveryDescriptor,
    method: 'GET' | 'PUT',
  ): Promise<TransferGrant[]> {
    const { env } = this;
    if (
      !env.R2_ORIGIN ||
      !env.R2_BUCKET_NAME ||
      !env.R2_ACCESS_KEY_ID ||
      !env.R2_SECRET_ACCESS_KEY
    )
      throw new Error('Private recovery signing unavailable');
    const client = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
      retries: 0,
    });
    return Promise.all(
      recoveryObjects(descriptor).map(async (object) => {
        const url = recoveryObjectUrl(env, object.key);
        url.searchParams.set('X-Amz-Expires', '900');
        const headers =
          method === 'PUT'
            ? {
                'content-md5': object.md5,
                'content-type':
                  object.key === descriptor.archive.key
                    ? 'application/gzip'
                    : object.key === descriptor.manifest.key
                      ? 'application/json'
                      : 'application/octet-stream',
              }
            : undefined;
        const request = await client.sign(url, {
          method,
          ...(headers ? { headers } : {}),
          aws: { signQuery: true, allHeaders: true },
        });
        return {
          key: object.key,
          url: request.url,
          ...(headers ? { headers } : {}),
        };
      }),
    );
  }
  async verify(
    checkpoint: RecoveryCheckpoint,
    options: { signal?: AbortSignal; shouldCancel?: () => boolean } = {},
  ): Promise<void> {
    const descriptor = this.descriptor(checkpoint);
    const bucket = this.env.RECOVERY_BUCKET;
    if (!bucket) throw new Error('Recovery bucket unavailable');
    const signal = options.signal ?? AbortSignal.timeout(600_000);
    // Only metadata crosses the manager; authenticated helper jobs verify SHA256.
    for (const expected of recoveryObjects(descriptor)) {
      signal.throwIfAborted();
      if (options.shouldCancel?.()) throw new Error('Preservation cancelled');
      const remote = await abortable(bucket.head(expected.key), signal);
      if (!remote || remote.size !== expected.size)
        throw new Error('Recovery object missing or incomplete');
      if (
        !remote.checksums.md5 ||
        base64(remote.checksums.md5) !== expected.md5
      )
        throw new Error('Recovery object metadata changed');
    }
  }
}
