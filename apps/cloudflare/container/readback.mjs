import { createHash } from 'node:crypto';
import { objects, grantsFor } from './objects.mjs';
/** R2 bytes are read and hashed inside the helper, never through the manager. */
export async function verifyRemote(descriptor, grants, signal) {
  const all = objects(descriptor),
    authorizations = grantsFor(grants, all);
  const tuples = [];
  for (const object of all) {
    signal.throwIfAborted();
    const response = await fetch(authorizations.get(object.key).url, {
      method: 'GET',
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Recovery readback unavailable');
    }
    let size = 0;
    const digest = createHash('sha256');
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > object.size)
        throw new Error('Recovery readback size mismatch');
      digest.update(chunk);
    }
    signal.throwIfAborted();
    const sha256 = digest.digest('hex');
    if (size !== object.size || sha256 !== object.sha256)
      throw new Error('Recovery readback checksum mismatch');
    tuples.push([object.key, size, sha256]);
  }
  tuples.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    version: 1,
    checkpointId: descriptor.checkpointId,
    count: tuples.length,
    objectsSha256: createHash('sha256')
      .update(JSON.stringify(tuples))
      .digest('hex'),
  };
}
