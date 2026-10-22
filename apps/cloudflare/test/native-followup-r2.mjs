import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { recoverySigner } from './native-followup-signing.mjs';
/** Native signed local R2, with no application signer/control surface. */
export async function recoveryStore() {
  const credentials = {
    accessKeyId: randomBytes(12).toString('hex'),
    secretAccessKey: randomBytes(32).toString('hex'),
  };
  const bucket = `followup-${randomUUID()}`;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '0.0.0.0',
      port: 0,
      modules: true,
      routes: ['host.docker.internal/*'],
      compatibilityDate: '2026-10-22',
      unsafeLocalExplorer: false,
      unsafeObservability: false,
      script:
        'export default {fetch(){return new Response(null,{status:404});}};',
      r2Buckets: { BUCKET: { id: bucket, s3Credentials: credentials } },
    }),
  );
  try {
    const ready = await mf.ready;
    const origin = `http://host.docker.internal:${ready.port}/cdn-cgi/local/r2/s3`;
    const disabled = await fetch(
      `http://127.0.0.1:${ready.port}/cdn-cgi/local/explorer/api/local/workers`,
      { signal: AbortSignal.timeout(15_000) },
    );
    assert.notEqual(
      disabled.status,
      200,
      'Synthetic R2 fixture must not expose Explorer',
    );
    const grants = await recoverySigner({
      R2_ORIGIN: origin,
      R2_BUCKET_NAME: bucket,
      LOCAL_R2_EMULATOR: '1',
      R2_ACCESS_KEY_ID: credentials.accessKeyId,
      R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    });
    return { origin, grants, close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
