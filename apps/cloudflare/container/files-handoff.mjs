import { mkdir, open, rename, rm, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { unsafeFileCharacters } from './files-scope.mjs';
import { inputDirectory, inputRecord, openInput } from './files-input.mjs';
const MAX_FILE = 5 * 1024 * 1024;
function validate(upload) {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(upload.id ?? '') ||
    !/^[a-f0-9]{64}$/.test(upload.sha256 ?? '') ||
    !Number.isSafeInteger(upload.size) ||
    upload.size < 0 ||
    upload.size > MAX_FILE ||
    typeof upload.name !== 'string' ||
    upload.name !== basename(upload.name) ||
    !upload.name ||
    unsafeFileCharacters(upload.name) ||
    ['.', '..', '.manifest.json'].includes(upload.name) ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(upload.mimeType ?? '')
  )
    throw new Error('Invalid upload');
  const url = new URL(upload.url);
  if (
    url.origin !== process.env.R2_ORIGIN ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    typeof upload.key !== 'string' ||
    !upload.key.startsWith('staging/') ||
    decodeURIComponent(url.pathname).split('/').slice(2).join('/') !==
      upload.key
  )
    throw new Error('Invalid upload grant');
}
export async function handoff(data) {
  if (
    !Array.isArray(data.uploads) ||
    data.uploads.length > 5 ||
    data.uploads.reduce((sum, item) => sum + item.size, 0) > 10 * 1024 * 1024
  )
    throw new Error('Invalid upload batch');
  data.uploads.forEach(validate);
  const base = await inputDirectory(data, true);
  const results = [];
  const signal = AbortSignal.timeout(90000);
  for (const upload of data.uploads) {
    const directory = resolve(base, upload.id);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    if ((await realpath(directory)) !== directory)
      throw new Error('Unsafe upload directory');
    let record;
    try {
      record = await inputRecord({ ...data, id: upload.id });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (record) {
      if (record.sha256 !== upload.sha256 || record.name !== upload.name)
        throw new Error('Upload identity changed');
      const current = await openInput({ ...data, id: upload.id });
      await current.handle.close();
      results.push({
        id: record.id,
        path: record.path,
        name: record.name,
        mimeType: record.mimeType,
      });
      continue;
    }
    const target = resolve(directory, upload.name);
    if (!target.startsWith(directory + '/'))
      throw new Error('Unsafe upload target');
    const temporary = resolve(directory, `.pending-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const response = await fetch(upload.url, {
        redirect: 'error',
        signal,
      });
      if (!response.ok || !response.body)
        throw new Error('Upload grant rejected');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > upload.size) {
          await response.body.cancel().catch(() => {});
          throw new Error('Upload exceeded size');
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (size !== upload.size || hash.digest('hex') !== upload.sha256)
        throw new Error('Upload verification failed');
      await handle.sync();
      await handle.chown(1000, 1000);
      await handle.close();
      await rename(temporary, target);
      await writeFile(
        resolve(directory, '.manifest.json'),
        JSON.stringify({ ...upload, url: undefined, path: target }),
        { flag: 'wx', mode: 0o600 },
      );
      results.push({
        id: upload.id,
        path: target,
        name: upload.name,
        mimeType: upload.mimeType,
      });
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { uploads: results };
}
