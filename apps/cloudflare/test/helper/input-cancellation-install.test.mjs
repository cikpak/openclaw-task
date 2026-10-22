import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upstreamSources } from './native-owner-fixture.mjs';
import { install, digest } from '../../container/native-owner/install.mjs';
import { inputCancellationPatches } from '../../container/native-owner/input-cancellation-patches.mjs';
const originals = upstreamSources();
for (const patch of inputCancellationPatches)
  test(`new ${patch.file} hash guard rejects without any image module/helper publication`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'prelude-guard-'));
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: '2026.10.1' }),
      );
      const values = {
        ...originals,
        [patch.file]:
          originals[patch.file] + '\n// unsupported upstream change',
      };
      for (const [file, source] of Object.entries(values))
        await writeFile(join(root, 'dist', file), source);
      await assert.rejects(() => install(root), /Unrecognized/);
      assert.deepEqual(
        (await readdir(join(root, 'dist'))).sort(),
        Object.keys(values).sort(),
      );
      for (const [file, source] of Object.entries(values))
        assert.equal(await readFile(join(root, 'dist', file), 'utf8'), source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
test('installer bakes exact input cancellation helper hash independently of canonical owner proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prelude-manifest-'));
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ version: '2026.10.1' }),
    );
    for (const [file, source] of Object.entries(originals))
      await writeFile(join(root, 'dist', file), source);
    const manifest = await install(root);
    assert.equal(
      manifest.inputCancellation,
      digest(
        await readFile(join(root, 'dist', 'messenger-input-cancellation.mjs')),
      ),
    );
    assert.equal(manifest.modules.length, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
