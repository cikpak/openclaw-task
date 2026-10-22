const UPLOAD_CHUNK_BYTES = 48 * 1024;
import { dispatchApplication } from '../lib/manager';
import { commandId } from '../lib/api';
/** Await each acknowledgement before reading the next bounded chunk. */
export async function uploadAttachment(file: File) {
  const begun = await dispatchApplication({
    type: 'upload.begin',
    commandId: commandId(),
    name: file.name,
    mimeType: file.type,
    size: file.size,
  });
  if (!begun.uploadId) throw new Error('Upload could not be started.');
  try {
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      const bytes = new Uint8Array(
        await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer(),
      );
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const result = await dispatchApplication({
        type: 'upload.chunk',
        commandId: commandId(),
        uploadId: begun.uploadId,
        offset,
        base64: btoa(binary),
      });
      if (result.nextOffset !== offset + bytes.length)
        throw new Error('Upload was interrupted. Please try again.');
    }
    const completed = await dispatchApplication({
      type: 'upload.complete',
      commandId: commandId(),
      uploadId: begun.uploadId,
    });
    if (!completed.upload)
      throw new Error('Upload response was invalid. Please try again.');
    return completed.upload;
  } catch (error) {
    // Unreferenced reservation can be retried or expire safely if connectivity is lost.
    await dispatchApplication({
      type: 'upload.remove',
      commandId: commandId(),
      uploadId: begun.uploadId,
    }).catch(() => undefined);
    throw error;
  }
}
