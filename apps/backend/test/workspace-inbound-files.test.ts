import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceArtifacts } from '../src/gateway/workspace-artifacts.js';
import { decodeArtifactId } from '../src/gateway/artifacts.js';

const agentId = `messenger-${randomUUID()}`;
const mapping = { agentId, sessionKey: `agent:${agentId}:main` };
const inbound = `media/inbound/openclaw-staged-${randomUUID()}/input-screenshot.png`;
const reader = new WorkspaceArtifacts(undefined);
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('does not classify the reserved inbound upload namespace as agent output', () => {
  for (const path of [
    'media/inbound',
    inbound,
    './' + inbound,
    'media/inbound/upload.pdf',
    'media/inbound/nested/document.txt',
    'MEDIA/INBOUND/upload.png',
  ]) {
    expect(() => reader.sourcePath(mapping, path)).toThrow();
    expect(() => reader.id(mapping, path)).toThrow();
  }
});

it('rejects native, sandbox and encoded links to an uploaded image', () => {
  const native = `/home/node/.openclaw/workspace/${agentId}/${inbound}`;
  for (const path of [
    native,
    `sandbox:${native}`,
    inbound.replace('inbound', '%69nbound'),
    inbound.replace('media/inbound/', 'media%2Finbound%2F'),
  ])
    expect(() => reader.sourcePath(mapping, path)).toThrow();
});

it('keeps generated images, input-prefixed outputs and unrelated inbound-named folders available', () => {
  for (const path of [
    'input-screenshot.png',
    'documents/input-summary.txt',
    'media/output/image.png',
    'media/inbound-report.png',
    'documents/media/inbound/report.txt',
    'inbound/report.pdf',
  ]) {
    expect(reader.sourcePath(mapping, path)).toBe(path);
    expect(reader.id(mapping, path)).toMatch(/^[A-Za-z0-9_-]+$/);
  }
});

it.skipIf(process.platform !== 'linux')(
  'excludes staged inputs before catalog limits while listing and downloading real outputs',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'messenger-inbound-regression-'));
    temporaryRoots.push(root);
    const workspace = join(root, agentId);
    const staged = join(
      workspace,
      'media',
      'inbound',
      `openclaw-staged-${randomUUID()}`,
    );
    const outputs = join(workspace, 'documents');
    await mkdir(staged, { recursive: true });
    await mkdir(outputs);
    await writeFile(
      join(staged, '.gitignore'),
      '# Raw task inputs remain private; copy outputs into the project to publish.\n*\n',
    );
    const generated = 'Generated document';
    await writeFile(join(outputs, 'input-summary.txt'), generated);
    await writeFile(join(outputs, 'generated.png'), 'Generated image');
    for (const name of ['input-summary.txt', 'generated.png'])
      await utimes(join(outputs, name), 1, 1);
    for (let i = 0; i < 110; i++)
      await writeFile(join(staged, `input-image-${i}.png`), 'Uploaded image');
    const bridge = new WorkspaceArtifacts(root);
    const files = await bridge.list(mapping);
    expect(files.map((file) => file.sourcePath).sort()).toEqual([
      'documents/generated.png',
      'documents/input-summary.txt',
    ]);
    const output = files.find(
      (file) => file.sourcePath === 'documents/input-summary.txt',
    )!;
    expect(
      (
        await bridge.download(mapping, decodeArtifactId(output.id))
      ).bytes.toString(),
    ).toBe(generated);
    // Previously issued IDs must also stop working, not just disappear from the list.
    const path = `media/inbound/${staged.split('/').at(-1)!}/input-image-0.png`;
    const legacyId =
      'messenger-workspace-v1:' +
      createHash('sha256')
        .update(JSON.stringify([agentId, mapping.sessionKey, path]))
        .digest('base64url');
    await expect(bridge.download(mapping, legacyId)).rejects.toMatchObject({
      status: 404,
    });
  },
);
