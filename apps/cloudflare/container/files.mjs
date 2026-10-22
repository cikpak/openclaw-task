import { pipeline } from 'node:stream/promises';
import { auditFile, spoolFile } from './files-audit.mjs';
import { openDocument } from './files-scope.mjs';
import { openInput } from './files-input.mjs';
import { handoff } from './files-handoff.mjs';
let activeWrites = 0;
export const filesBusy = () => activeWrites > 0;
const mime = (name) =>
  ({
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    html: 'text/html',
    zip: 'application/zip',
  })[name.split('.').at(-1)?.toLowerCase()] ?? 'application/octet-stream';
async function auditedMetadata(opened, data) {
  try {
    const digest = await auditFile(opened, data);
    const after = await opened.handle.stat();
    return {
      path: opened.path,
      documentsRoot: opened.documentsRoot,
      name: opened.name,
      mimeType: opened.mimeType ?? mime(opened.name),
      size: after.size,
      modifiedAt: Math.trunc(after.mtimeMs),
      digest,
    };
  } finally {
    await opened.handle.close();
  }
}
export async function metadata(data) {
  return auditedMetadata(await openDocument(data), data);
}
export async function inputMetadata(data) {
  return auditedMetadata(await openInput(data), data);
}
export async function filesRoute(request, response, data) {
  if (request.url === '/files/metadata') return { value: await metadata(data) };
  if (request.url === '/files/input-metadata')
    return { value: await inputMetadata(data) };
  if (request.url === '/files/handoff') {
    activeWrites++;
    try {
      return { value: await handoff(data) };
    } finally {
      activeWrites--;
    }
  }
  if (!['/files/read', '/files/input'].includes(request.url)) return null;
  const opened = await spoolFile(
    request.url === '/files/input'
      ? await openInput(data)
      : await openDocument(data),
    data,
  );
  response.writeHead(200, {
    'content-type': opened.mimeType ?? mime(opened.name),
    'content-length': opened.stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  try {
    await pipeline(
      opened.handle.createReadStream({ autoClose: false, start: 0 }),
      response,
    );
  } finally {
    await opened.cleanup();
  }
  return { streamed: true };
}
