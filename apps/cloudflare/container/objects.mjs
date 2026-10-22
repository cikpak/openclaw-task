import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { validId } from './jobs.mjs';
export function objects(descriptor) {
  if (
    descriptor?.version !== 1 ||
    !validId(descriptor.checkpointId) ||
    !Array.isArray(descriptor.files)
  )
    throw new Error('Invalid checkpoint descriptor');
  const prefix = `recovery/${descriptor.checkpointId}/`;
  if (
    descriptor.archive?.key !== `${prefix}internal.tar.gz` ||
    descriptor.manifest?.key !== `${prefix}manifest.json`
  )
    throw new Error('Invalid archive key');
  const unique = new Map();
  for (const object of [
    descriptor.archive,
    descriptor.manifest,
    ...descriptor.files,
  ]) {
    if (
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      !/^[a-f0-9]{64}$/.test(object.sha256) ||
      !/^[A-Za-z0-9+/]{22}==$/.test(object.md5 ?? '')
    )
      throw new Error('Invalid object metadata');
    if (
      object !== descriptor.archive &&
      object !== descriptor.manifest &&
      !new RegExp(`^files/(?:[A-Za-z0-9_-]{1,80}/)?${object.sha256}$`).test(
        object.key,
      )
    )
      throw new Error('Invalid user object key');
    const previous = unique.get(object.key);
    if (
      previous &&
      (previous.size !== object.size ||
        previous.sha256 !== object.sha256 ||
        previous.md5 !== object.md5)
    )
      throw new Error('Conflicting object metadata');
    unique.set(object.key, object);
  }
  return [...unique.values()];
}
export function filename(object, descriptor) {
  if (object.key === descriptor.archive.key) return 'internal.tar.gz';
  if (object.key === descriptor.manifest.key) return 'manifest.json';
  return `user-${object.sha256}`;
}
export async function verify(path, object) {
  if ((await stat(path)).size !== object.size)
    throw new Error('Object size mismatch');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== object.sha256)
    throw new Error('Object hash mismatch');
}
export function grantsFor(grants, expected) {
  if (!Array.isArray(grants) || grants.length !== expected.length)
    throw new Error('Incorrect grant count');
  const allowed = new Map(expected.map((object) => [object.key, object])),
    result = new Map();
  for (const grant of grants) {
    if (!grant || !allowed.has(grant.key) || result.has(grant.key))
      throw new Error('Invalid transfer grant');
    const url = new URL(grant.url);
    if (
      url.protocol !== 'https:' ||
      !process.env.R2_ORIGIN ||
      url.origin !== process.env.R2_ORIGIN ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Unsafe transfer endpoint');
    if (!decodeURIComponent(url.pathname).endsWith(`/${grant.key}`))
      throw new Error('Transfer object mismatch');
    if (
      grant.headers !== undefined &&
      (!grant.headers ||
        typeof grant.headers !== 'object' ||
        Array.isArray(grant.headers) ||
        Object.keys(grant.headers).some(
          (key) => !['content-type', 'content-md5'].includes(key.toLowerCase()),
        ))
    )
      throw new Error('Unsafe transfer headers');
    result.set(grant.key, grant);
  }
  return result;
}
