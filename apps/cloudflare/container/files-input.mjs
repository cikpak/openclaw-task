import { mkdir, realpath, open } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileScope, unsafeFileCharacters } from './files-scope.mjs';
export async function inputDirectory(data, create = false) {
  const { workspace, documentsRoot } = await fileScope(data);
  const session = createHash('sha256').update(data.sessionKey).digest('hex');
  const path = resolve(documentsRoot, '.messenger-inputs', session);
  if (create) await mkdir(path, { recursive: true, mode: 0o755 });
  if ((await realpath(path)) !== path || !path.startsWith(workspace + '/'))
    throw new Error('Unsafe import directory');
  return path;
}
export async function inputRecord(data) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(data.id ?? ''))
    throw new Error('Invalid upload ID');
  const directory = resolve(await inputDirectory(data), data.id);
  if ((await realpath(directory)) !== directory)
    throw new Error('Unsafe upload directory');
  const manifest = await open(
    resolve(directory, '.manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let record;
  try {
    record = JSON.parse(await manifest.readFile('utf8'));
  } finally {
    await manifest.close();
  }
  if (
    record.id !== data.id ||
    typeof record.path !== 'string' ||
    relative(directory, record.path) !== record.name ||
    unsafeFileCharacters(record.name) ||
    record.name.includes('/')
  )
    throw new Error('Invalid upload record');
  return record;
}
export async function openInput(data) {
  const record = await inputRecord(data);
  const handle = await open(
    record.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== record.path)
      throw new Error('Upload moved');
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Invalid upload file');
    return {
      handle,
      stat,
      path: record.path,
      name: record.name,
      mimeType: record.mimeType,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
