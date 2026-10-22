import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patches } from './patches.mjs';
export const digest = (source) =>
  createHash('sha256').update(source).digest('hex');
export function transform(source, patch) {
  if (digest(source) !== patch.sha256)
    throw new Error(`Unrecognized pinned native module: ${patch.file}`);
  for (const [before, after] of patch.replacements) {
    if (source.split(before).length !== 2)
      throw new Error(`Native patch requires one exact match: ${patch.file}`);
    source = source.replace(before, after);
  }
  return (patch.prefix ?? '') + source;
}
export async function install(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '2026.10.1')
    throw new Error('Unsupported native version');
  // Validate every original hash and every insertion before writing any file.
  const prepared = await Promise.all(
    patches.map(async (patch) => ({
      file: join(root, 'dist', patch.file),
      source: transform(
        await readFile(join(root, 'dist', patch.file), 'utf8'),
        patch,
      ),
      before: patch.sha256,
    })),
  );
  const proof = await readFile(new URL('./proof.mjs', import.meta.url), 'utf8');
  for (const file of prepared) await writeFile(file.file, file.source);
  await writeFile(join(root, 'dist', 'messenger-owner-proof.mjs'), proof);
  const manifest = {
    version: pkg.version,
    modules: prepared.map((file) => ({
      file: file.file,
      before: file.before,
      after: digest(file.source),
    })),
    proof: digest(proof),
  };
  await writeFile(
    join(root, 'dist', 'messenger-compatibility.json'),
    JSON.stringify(manifest) + '\n',
  );
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(
    JSON.stringify({
      nativeProcessingOwnerPatch: await install(process.argv[2] ?? '/app'),
    }),
  );
