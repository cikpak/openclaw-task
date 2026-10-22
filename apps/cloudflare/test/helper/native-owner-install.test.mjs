import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { patches } from '../../container/native-owner/patches.mjs';
import {
  digest,
  install,
  transform,
} from '../../container/native-owner/install.mjs';
import { upstreamSources } from './native-owner-fixture.mjs';
const sources = upstreamSources();
for (const failure of ['version', 'hash', 'ambiguous-anchor'])
  test(`installer ${failure} guard rejects before any module write`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-owner-'));
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          version: failure === 'version' ? 'unexpected' : '2026.10.1',
        }),
      );
      const values = { ...sources };
      if (failure === 'hash')
        values[patches.at(-1).file] += '\n// Changed upstream bytes';
      for (const [file, source] of Object.entries(values))
        await writeFile(join(root, 'dist', file), source);
      if (failure === 'ambiguous-anchor') {
        const patch = patches.at(-1),
          previous = patch.replacements;
        try {
          patch.replacements = [['const', 'replacement']];
          await assert.rejects(() => install(root), /one exact match/);
        } finally {
          patch.replacements = previous;
        }
      } else
        await assert.rejects(() => install(root), /Unsupported|Unrecognized/);
      for (const [file, source] of Object.entries(values))
        assert.equal(await readFile(join(root, 'dist', file), 'utf8'), source);
      assert.deepEqual(
        (await readdir(join(root, 'dist'))).sort(),
        Object.keys(values).sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test('installer requires a unique insertion and bakes exact before/after/proof hashes', async () => {
  assert.throws(
    () =>
      transform('same same', {
        file: 'fixture',
        sha256: digest('same same'),
        replacements: [['same', 'after']],
      }),
    /one exact match/,
  );
  const root = await mkdtemp(join(tmpdir(), 'native-owner-'));
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ version: '2026.10.1' }),
    );
    for (const [file, source] of Object.entries(sources))
      await writeFile(join(root, 'dist', file), source);
    const manifest = await install(root);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(root, 'dist', 'messenger-compatibility.json'),
          'utf8',
        ),
      ),
      manifest,
    );
    assert.equal(manifest.version, '2026.10.1');
    for (const [index, module] of manifest.modules.entries()) {
      assert.equal(module.before, patches[index].sha256);
      assert.equal(module.after, digest(await readFile(module.file)));
    }
    assert.equal(
      manifest.proof,
      digest(await readFile(join(root, 'dist', 'messenger-owner-proof.mjs'))),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
