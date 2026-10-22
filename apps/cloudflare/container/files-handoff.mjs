import { validTransferUrl } from './r2-url.mjs';
import { basename } from 'node:path';
import { unsafeFileCharacters } from './files-scope.mjs';
import { inputLease } from './files-input.mjs';
import { handoffEntry } from './files-handoff-entry.mjs';
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
  if (
    typeof upload.key !== 'string' ||
    !upload.key.startsWith('staging/') ||
    !validTransferUrl(upload.url, upload.key)
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
  const lease = await inputLease(data);
  try {
    const uploads = [];
    const signal = AbortSignal.timeout(90_000);
    for (const upload of data.uploads)
      uploads.push(await handoffEntry(data, upload, lease, signal));
    await lease.verify();
    return { uploads };
  } finally {
    await lease.close();
  }
}
