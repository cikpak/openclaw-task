import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { objects, filename, grantsFor, verify } from './objects.mjs';
export async function upload(stage, descriptor, grants, reuse = [], signal) {
  const all = objects(descriptor),
    reused = new Set(reuse);
  if (
    !Array.isArray(reuse) ||
    reused.size !== reuse.length ||
    reuse.some(
      (key) =>
        !all.some((object) => object.key === key && key.startsWith('files/')),
    )
  )
    throw new Error('Invalid reused objects');
  const changed = all.filter((object) => !reused.has(object.key)),
    authorizations = grantsFor(grants, changed),
    receipts = [];
  for (const object of changed) {
    signal.throwIfAborted();
    const path = join(stage, filename(object, descriptor));
    await verify(path, object);
    const grant = authorizations.get(object.key),
      headers = {
        ...grant.headers,
        'content-md5': object.md5,
        'content-length': String(object.size),
      };
    const response = await fetch(grant.url, {
      method: 'PUT',
      headers,
      body: createReadStream(path),
      duplex: 'half',
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Object upload rejected');
    }
    await response.body?.cancel();
    receipts.push({
      key: object.key,
      size: object.size,
      sha256: object.sha256,
      etag: response.headers.get('etag'),
    });
  }
  return {
    uploaded: true,
    checkpointId: descriptor.checkpointId,
    objects: receipts,
    reused: [...reused],
  };
}
export async function download(stage, descriptor, grants, signal) {
  const all = objects(descriptor),
    authorizations = grantsFor(grants, all);
  for (const object of all) {
    signal.throwIfAborted();
    const response = await fetch(authorizations.get(object.key).url, {
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Object download rejected');
    }
    let count = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        count += chunk.length;
        callback(
          count > object.size ? new Error('Object size exceeded') : null,
          chunk,
        );
      },
    });
    const path = join(stage, filename(object, descriptor));
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    await verify(path, object);
  }
}
