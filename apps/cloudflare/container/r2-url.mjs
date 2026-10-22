const LOCAL_PATH = '/cdn-cgi/local/r2/s3';
/** Match the configured private origin and exactly one bucket plus object key. */
export function validTransferUrl(value, key) {
  const url = new URL(value);
  const configured = process.env.R2_ORIGIN;
  if (!configured) return false;
  const origin = new URL(configured);
  const local =
    process.env.LOCAL_R2_EMULATOR === '1' &&
    origin.protocol === 'http:' &&
    origin.hostname === 'host.docker.internal' &&
    Boolean(origin.port) &&
    origin.pathname === LOCAL_PATH &&
    `${origin.origin}${origin.pathname}` === configured;
  const production =
    origin.protocol === 'https:' && origin.origin === configured;
  if (
    (!local && !production) ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.hash ||
    typeof key !== 'string'
  )
    return false;
  const path = url.pathname.slice(local ? LOCAL_PATH.length : 0);
  if (local && !url.pathname.startsWith(`${LOCAL_PATH}/`)) return false;
  const [empty, bucket, ...parts] = path.split('/');
  return (
    empty === '' &&
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') &&
    parts.join('/') === key.split('/').map(encodeURIComponent).join('/')
  );
}
