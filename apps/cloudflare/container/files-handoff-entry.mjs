import { pdfReadFiles } from './pdf-input.mjs';
import { mkdir, open, rename, rm, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { inputRecord, openInput } from './files-input.mjs';
export async function handoffEntry(data, upload, lease, signal) {
  const directory = resolve(lease.path, upload.id);
  const pinnedPath = `${lease.fdPath}/${upload.id}`;
  await lease.verify();
  try {
    await mkdir(pinnedPath, { mode: 0o755 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directoryHandle = await open(
    pinnedPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const base = `/proc/self/fd/${directoryHandle.fd}`;
  let temporary, handle;
  const verify = async () => {
    await lease.verify();
    const stat = await directoryHandle.stat();
    if (
      stat.uid !== 0 ||
      stat.mode & 0o022 ||
      (await realpath(base)) !== directory
    )
      throw new Error('Unsafe upload directory');
  };
  try {
    await verify();
    const result = async (record) => {
      await verify();
      const value = {
        id: record.id,
        path: record.path,
        name: record.name,
        mimeType: record.mimeType,
        ...(record.mimeType === 'application/pdf'
          ? { readFiles: await pdfReadFiles(record.path, directory, signal) }
          : {}),
      };
      await verify();
      return value;
    };
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
      return await result(record);
    }
    const target = resolve(directory, upload.name);
    temporary = `${base}/.pending-${randomUUID()}`;
    handle = await open(temporary, 'wx', 0o600);
    const response = await fetch(upload.url, { redirect: 'error', signal });
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
    handle = undefined;
    await verify();
    await rename(temporary, `${base}/${upload.name}`);
    temporary = undefined;
    record = { ...upload, url: undefined, path: target };
    await writeFile(`${base}/.manifest.json`, JSON.stringify(record), {
      flag: 'wx',
      mode: 0o600,
    });
    return await result(record);
  } finally {
    await handle?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
    await directoryHandle.close();
  }
}
