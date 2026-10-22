/** Isolated pinned native extractor. No helper/provider credentials are inherited. */
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { t as extractPdfContent } from '/app/dist/pdf-extract-GHL8FMGI.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { plugins } = JSON.parse(input);
  const destination = '/proc/self/fd/4';
  const buffer = readFileSync(3);
  if (
    buffer.length > 5 * 1024 * 1024 ||
    !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))
  )
    throw new Error('Invalid PDF');
  const result = await extractPdfContent({
    buffer,
    config: { plugins },
    maxPages: 4,
    maxPixels: 4_000_000,
    minTextChars: 200,
    signal: AbortSignal.timeout(60_000),
  });
  const metadata = result.metadata;
  if (
    !metadata ||
    metadata.pages?.truncated ||
    metadata.textTruncated ||
    metadata.imagesTruncated ||
    result.text.length > 60_000
  )
    throw new Error('PDF extraction incomplete');
  const files = [];
  const save = async (name, mimeType, bytes) => {
    const path = resolve(destination, name);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    files.push({
      name,
      mimeType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    });
  };
  if (result.text.trim())
    await save('extracted-text.txt', 'text/plain', Buffer.from(result.text));
  for (const [index, image] of result.images.entries()) {
    if (image.mimeType !== 'image/png') throw new Error('Invalid PDF fallback');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > 4_000_000 * 4 + 100_000)
      throw new Error('PDF fallback exceeded pixel budget');
    await save(`page-${index + 1}.png`, 'image/png', bytes);
  }
  if (!files.length) throw new Error('PDF has no readable content');
  await new Promise((resolve) =>
    process.stdout.write(JSON.stringify({ files }), resolve),
  );
  process.exit(0);
} catch {
  process.exit(1);
}
