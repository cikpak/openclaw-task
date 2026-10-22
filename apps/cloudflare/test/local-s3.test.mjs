import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { AwsClient } from 'aws4fetch';
import { validTransferUrl } from '../container/r2-url.mjs';
import { verifyRemote } from '../container/readback.mjs';
import { upload } from '../container/transfers.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const origin = 'http://host.docker.internal:8787/cdn-cgi/local/r2/s3';
const key = 'staging/uploads/test/content';
test('helper local endpoint requires explicit opt-in and exact bucket/object path', () => {
  const previous = {
    R2_ORIGIN: process.env.R2_ORIGIN,
    LOCAL_R2_EMULATOR: process.env.LOCAL_R2_EMULATOR,
  };
  try {
    process.env.R2_ORIGIN = origin;
    delete process.env.LOCAL_R2_EMULATOR;
    assert.equal(validTransferUrl(`${origin}/recovery/${key}`, key), false);
    process.env.LOCAL_R2_EMULATOR = '1';
    assert.equal(
      validTransferUrl(`${origin}/recovery/${key}?signed=true`, key),
      true,
    );
    for (const url of [
      `${origin}/recovery/extra/${key}`,
      `${origin}/recovery/${key}/other`,
      `${origin}/recovery/${key}#fragment`,
      `${origin}/recovery/${key}`.replace('host.docker.internal', 'localhost'),
      `${origin}/recovery/${key}`.replace('/s3/', '/s3-other/'),
      `${origin}/recovery/${key}`.replace('http://', 'http://user@'),
    ])
      assert.equal(validTransferUrl(url, key), false, url);
    process.env.R2_ORIGIN = 'https://abc123.r2.cloudflarestorage.com';
    delete process.env.LOCAL_R2_EMULATOR;
    assert.equal(
      validTransferUrl(`${process.env.R2_ORIGIN}/recovery/${key}`, key),
      true,
    );
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('actual Miniflare S3 verifies method/key/expiry/signature and shares the R2 binding', async () => {
  const contents = `
    import {RecoveryObjects} from './src/engine/recovery/objects.ts';
    import {UploadObjects} from './src/files/uploads/objects.ts';
    export default { async fetch(request,env) {
      const data=await request.json();
      const signer=new RecoveryObjects(env);
      return Response.json({grants:await signer.grants(data.descriptor,data.method),upload:await new UploadObjects(env).signedGet({key:data.descriptor.archive.key})});
    }};
  `;
  const bundle = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'cloudflare:*'],
    write: false,
  });
  const credentials = {
    accessKeyId: 'local-only-access',
    secretAccessKey: 'local-only-secret',
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      routes: ['host.docker.internal/*'],
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat'],
      r2Buckets: {
        RECOVERY_BUCKET: { id: 'recovery', s3Credentials: credentials },
      },
      bindings: {
        R2_ORIGIN: origin,
        R2_BUCKET_NAME: 'recovery',
        LOCAL_R2_EMULATOR: '1',
        R2_ACCESS_KEY_ID: credentials.accessKeyId,
        R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      },
    }),
  );
  try {
    const body = Buffer.from('local recovery with exact grants');
    const metadata = {
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
      md5: createHash('md5').update(body).digest('base64'),
    };
    const descriptor = {
      version: 1,
      checkpointId: 'test',
      archive: { ...metadata, key: 'recovery/test/internal.tar.gz' },
      manifest: { ...metadata, key: 'recovery/test/manifest.json' },
      files: [],
    };
    const sign = async (method) => {
      const response = await mf.dispatchFetch('http://application/sign', {
        method: 'POST',
        body: JSON.stringify({ descriptor, method }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const ready = await mf.ready;
    const transfer = (value, init = {}) =>
      new Promise((resolve, reject) => {
        const url = new URL(value);
        const request = httpRequest(
          {
            hostname: ready.hostname,
            port: ready.port,
            path: url.pathname + url.search,
            method: init.method ?? 'GET',
            headers: { ...init.headers, host: url.host },
          },
          (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
              resolve(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode,
                }),
              ),
            );
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        if (init.body?.pipe) init.body.pipe(request);
        else request.end(init.body);
      });
    const puts = await sign('PUT');
    const put = puts.grants[0];
    assert.equal(
      new URL(put.url).pathname,
      `/cdn-cgi/local/r2/s3/recovery/${put.key}`,
    );
    let response = await transfer(put.url, {
      method: 'PUT',
      headers: put.headers,
      body,
    });
    assert.equal(response.status, 200, await response.text());
    const second = puts.grants[1];
    response = await transfer(second.url, {
      method: 'PUT',
      headers: second.headers,
      body,
    });
    assert.equal(response.status, 200, await response.text());
    const bucket = await mf.getR2Bucket('RECOVERY_BUCKET');
    assert.equal(await (await bucket.get(put.key)).text(), body.toString());
    const gets = await sign('GET');
    response = await transfer(gets.grants[0].url);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await response.text(), body.toString());
    const originalFetch = globalThis.fetch,
      previousOrigin = process.env.R2_ORIGIN,
      previousFlag = process.env.LOCAL_R2_EMULATOR;
    try {
      process.env.R2_ORIGIN = origin;
      process.env.LOCAL_R2_EMULATOR = '1';
      globalThis.fetch = transfer;
      const stage = await mkdtemp(join(tmpdir(), 'messenger-readback-'));
      let receipt;
      try {
        await writeFile(join(stage, 'internal.tar.gz'), body);
        await writeFile(join(stage, 'manifest.json'), body);
        const result = await upload(
          stage,
          descriptor,
          puts.grants,
          [],
          new AbortController().signal,
          gets.grants,
        );
        receipt = result.verification;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      assert.equal(receipt.count, 2);
      await bucket.put(put.key, Buffer.alloc(body.length, 0));
      await assert.rejects(
        () =>
          verifyRemote(descriptor, gets.grants, new AbortController().signal),
        /checksum mismatch/,
      );
      await bucket.put(put.key, body);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousOrigin === undefined) delete process.env.R2_ORIGIN;
      else process.env.R2_ORIGIN = previousOrigin;
      if (previousFlag === undefined) delete process.env.LOCAL_R2_EMULATOR;
      else process.env.LOCAL_R2_EMULATOR = previousFlag;
    }
    response = await transfer(gets.upload);
    assert.equal(response.status, 200, await response.clone().text());
    const expiredUrl = new URL(gets.grants[0].url);
    expiredUrl.search = '?X-Amz-Expires=1';
    const expired = await new AwsClient({
      ...credentials,
      service: 's3',
      region: 'auto',
    }).sign(expiredUrl, {
      method: 'GET',
      aws: { signQuery: true, datetime: '20000101T000000Z' },
    });
    response = await transfer(expired.url);
    assert.equal(
      response.status,
      403,
      'a correctly signed expired grant must be rejected',
    );
    await response.body?.cancel();
    for (const [url, init] of [
      [gets.grants[0].url, { method: 'DELETE' }],
      [gets.grants[0].url.replace('/internal.tar.gz', '/other.tar.gz'), {}],
      [gets.grants[0].url.replace('X-Amz-Expires=900', 'X-Amz-Expires=0'), {}],
      [
        gets.grants[0].url.replace('X-Amz-Signature=', 'X-Amz-Signature=bad'),
        {},
      ],
    ]) {
      response = await transfer(url, init);
      assert.ok(
        response.status >= 400,
        `tampered grant accepted: ${response.status}`,
      );
      await response.body?.cancel();
    }
    assert.equal(await (await bucket.get(put.key)).text(), body.toString());
  } finally {
    await mf.dispose();
  }
});
