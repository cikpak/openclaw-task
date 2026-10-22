import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runtime } from './environment.mjs';
function scanner(data) {
  const values = [
    ...Object.entries(process.env)
      .filter(([key]) => /(?:TOKEN|API_KEY|SECRET_ACCESS_KEY)$/.test(key))
      .map(([, value]) => value),
    ...(data.secrets ?? []),
  ].filter((value) => typeof value === 'string' && value.length > 0);
  if (values.some((value) => value.length > 65536))
    throw new Error('Invalid credential bound');
  const secrets = values.map((value) => Buffer.from(value));
  const keep = Math.max(1, ...secrets.map((value) => value.length)) - 1;
  let pending = Buffer.alloc(0);
  return (chunk) => {
    const window = Buffer.concat([pending, chunk]);
    if (secrets.some((secret) => window.includes(secret)))
      throw new Error('Private file content');
    pending = keep
      ? window.subarray(Math.max(0, window.length - keep))
      : Buffer.alloc(0);
  };
}
export async function auditFile(opened, data, destination) {
  const hash = createHash('sha256'),
    scan = scanner(data);
  scan(Buffer.from(opened.name));
  for await (const chunk of opened.handle.createReadStream({
    autoClose: false,
  })) {
    scan(chunk);
    hash.update(chunk);
    if (destination) await destination.write(chunk);
  }
  const after = await opened.handle.stat();
  if (
    after.size !== opened.stat.size ||
    after.mtimeMs !== opened.stat.mtimeMs ||
    after.ctimeMs !== opened.stat.ctimeMs
  )
    throw new Error('File changed during audit');
  return hash.digest('hex');
}
/** Spool from the verified inode before admission: later native writes cannot alter an admitted transfer. */
export async function spoolFile(
  opened,
  data,
  filesystem = { mkdtemp, open, rm },
) {
  let directory, handle;
  try {
    directory = await filesystem.mkdtemp(join(runtime, 'file-reader-'));
    handle = await filesystem.open(join(directory, 'content'), 'wx+', 0o600);
    await auditFile(opened, data, handle);
    await opened.handle.close();
    return {
      ...opened,
      handle,
      cleanup: async () => {
        try {
          await handle.close();
        } finally {
          await filesystem.rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await opened.handle.close().catch(() => {});
    await handle?.close().catch(() => {});
    if (directory)
      await filesystem
        .rm(directory, { recursive: true, force: true })
        .catch(() => {});
    throw error;
  }
}
