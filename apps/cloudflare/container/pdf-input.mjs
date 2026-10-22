import { extract } from './pdf-extraction.mjs';
import {
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  chown,
  chmod,
  realpath,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runtime } from './environment.mjs';
import {
  digest,
  verified,
  pinDirectory,
  readManifest,
  currentConfig,
  validFiles,
} from './pdf-files.mjs';
/** Original stays authoritative. Only immutable helper snapshots reach the unprivileged extractor. */
export async function pdfReadFiles(source, directory, signal) {
  const pinned = await pinDirectory(directory);
  const base = `/proc/self/fd/${pinned.fd}`;
  let spool, temporary;
  try {
    const original = await verified(source);
    if (original.length > 5 * 1024 * 1024)
      throw new Error('PDF exceeded upload limit');
    const plugins = await currentConfig();
    const hash = digest(original),
      name = `.pdf-read-${digest(Buffer.concat([original, Buffer.from(JSON.stringify(plugins ?? null))]))}`;
    const destination = resolve(directory, name);
    let result;
    try {
      result = await readManifest(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      spool = await mkdtemp(`${runtime}/pdf-`);
      await writeFile(resolve(spool, 'source.pdf'), original, {
        flag: 'wx',
        mode: 0o600,
      });
      await mkdir(resolve(spool, 'output'), { mode: 0o700 });
      await chown(resolve(spool, 'output'), 1000, 1000);
      result = await extract(
        resolve(spool, 'source.pdf'),
        resolve(spool, 'output'),
        plugins,
        signal,
      );
      result.sourceSha256 = hash;
      const files = validFiles(result);
      temporary = `${base}/.pdf-pending-${randomUUID()}`;
      await mkdir(temporary, { mode: 0o755 });
      for (const file of files) {
        const bytes = await verified(resolve(spool, 'output', file.name), file);
        await writeFile(`${temporary}/${file.name}`, bytes, {
          flag: 'wx',
          mode: 0o600,
        });
        await chown(`${temporary}/${file.name}`, 0, 1000);
        await chmod(`${temporary}/${file.name}`, 0o440);
        if (digest(bytes) !== file.sha256)
          throw new Error('Invalid extracted PDF');
      }
      await writeFile(`${temporary}/.manifest.json`, JSON.stringify(result), {
        flag: 'wx',
        mode: 0o600,
      });
      if (
        digest(await verified(source)) !== hash ||
        (await realpath(base)) !== directory
      )
        throw new Error('PDF moved during extraction');
      await rename(temporary, `${base}/${name}`);
      temporary = undefined;
    }
    if (result.sourceSha256 !== hash)
      throw new Error('PDF companion source mismatch');
    const files = [];
    for (const file of validFiles(result)) {
      const path = resolve(destination, file.name);
      await verified(path, file);
      files.push({ path, name: file.name, mimeType: file.mimeType });
    }
    if (
      digest(await verified(source)) !== hash ||
      (await realpath(base)) !== directory
    )
      throw new Error('PDF changed during handoff');
    return files;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (spool) await rm(spool, { recursive: true, force: true });
    await pinned.close();
  }
}
