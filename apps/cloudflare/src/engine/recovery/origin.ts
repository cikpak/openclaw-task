import type { ManagerEnv } from '../../manager/types.js';

const LOCAL_PATH = '/cdn-cgi/local/r2/s3';
/** Local HTTP is confined to Docker's host bridge and Miniflare's S3 adapter. */
export function recoveryObjectUrl(env: ManagerEnv, key: string): URL {
  const origin = new URL(env.R2_ORIGIN!);
  const local =
    env.LOCAL_R2_EMULATOR === '1' &&
    origin.protocol === 'http:' &&
    origin.hostname === 'host.docker.internal' &&
    Boolean(origin.port) &&
    origin.pathname === LOCAL_PATH &&
    `${origin.origin}${origin.pathname}` === env.R2_ORIGIN;
  const production =
    origin.protocol === 'https:' &&
    /^[a-f0-9]+\.r2\.cloudflarestorage\.com$/.test(origin.hostname) &&
    origin.origin === env.R2_ORIGIN;
  if (!local && !production) throw new Error('Invalid private recovery origin');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BUCKET_NAME ?? ''))
    throw new Error('Invalid private recovery bucket');
  const path = key.split('/').map(encodeURIComponent).join('/');
  return new URL(
    `${local ? LOCAL_PATH : ''}/${env.R2_BUCKET_NAME}/${path}`,
    origin,
  );
}
