import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
/** Invoke the production signer locally; no signer HTTP route is exposed. */
export async function recoverySigner(env) {
  const app = resolve(import.meta.dirname, '..');
  const outfile = resolve(
    app,
    'node_modules/.cache/native-followup/signing.mjs',
  );
  await build({
    entryPoints: [resolve(app, 'src/engine/recovery/objects.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  const { RecoveryObjects } = await import(pathToFileURL(outfile).href);
  const signer = new RecoveryObjects(env);
  return (descriptor, method) => signer.grants(descriptor, method);
}
