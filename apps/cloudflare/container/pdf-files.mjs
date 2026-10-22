import { constants } from 'node:fs';
import { open, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export const digest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export async function verified(path, expected) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (
      (await realpath(`/proc/self/fd/${handle.fd}`)) !== path ||
      !(await handle.stat()).isFile()
    )
      throw new Error('Unsafe PDF input');
    const stat = await handle.stat();
    if (stat.size > (expected?.size ?? 5 * 1024 * 1024))
      throw new Error('PDF file exceeded bounds');
    const chunks = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > (expected?.size ?? 5 * 1024 * 1024))
        throw new Error('PDF file exceeded bounds');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (
      expected &&
      (bytes.length !== expected.size || digest(bytes) !== expected.sha256)
    )
      throw new Error('PDF companion changed');
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function pinDirectory(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (
      (await realpath(`/proc/self/fd/${handle.fd}`)) !== path ||
      (await handle.stat()).uid !== 0
    )
      throw new Error('Unsafe PDF directory');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function readManifest(path) {
  const directory = await pinDirectory(path);
  try {
    const handle = await open(
      `/proc/self/fd/${directory.fd}/.manifest.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if ((await handle.stat()).uid !== 0)
        throw new Error('Unsafe PDF manifest');
      return JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
  } finally {
    await directory.close();
  }
}
export async function currentConfig() {
  const { plugins } = JSON.parse(
    await readFile(process.env.OPENCLAW_CONFIG_PATH, 'utf8'),
  );
  const policy = {};
  if (typeof plugins?.enabled === 'boolean') policy.enabled = plugins.enabled;
  const list = (value) =>
    Array.isArray(value)
      ? value
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
      : [];
  const allow = list(plugins?.allow);
  if (allow.length)
    policy.allow = [
      allow.includes('document-extract')
        ? 'document-extract'
        : 'messenger-unrelated-plugin',
    ];
  if (list(plugins?.deny).includes('document-extract'))
    policy.deny = ['document-extract'];
  for (const [id, entry] of Object.entries(plugins?.entries ?? {})) {
    if (
      id.trim().toLowerCase() === 'document-extract' &&
      typeof entry?.enabled === 'boolean'
    )
      policy.entries = { 'document-extract': { enabled: entry.enabled } };
  }
  return policy;
}

export function validFiles(result) {
  if (
    !Array.isArray(result.files) ||
    !result.files.length ||
    result.files.length > 5
  )
    throw new Error('Invalid PDF companions');
  for (const file of result.files) {
    if (
      !/^(?:extracted-text\.txt|page-[1-4]\.png)$/.test(file.name) ||
      !['text/plain', 'image/png'].includes(file.mimeType) ||
      (file.name === 'extracted-text.txt') !==
        (file.mimeType === 'text/plain') ||
      !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > (file.mimeType === 'text/plain' ? 240_000 : 16_100_000)
    )
      throw new Error('Invalid PDF companion');
  }
  return result.files;
}
