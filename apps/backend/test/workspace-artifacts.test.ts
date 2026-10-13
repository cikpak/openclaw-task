import { expect, it } from 'vitest';
const linuxTest = it.skipIf(process.platform !== 'linux');
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  link,
  truncate,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkspaceArtifacts } from '../src/gateway/workspace-artifacts.js';
import { decodeArtifactId } from '../src/gateway/artifacts.js';
import { FILE_LIMIT } from '../src/uploads/validation.js';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-docs-'));
  const agentId = `messenger-${randomUUID()}`;
  const mapping = { agentId, sessionKey: `agent:${agentId}:main` };
  const folder = join(root, agentId);
  await mkdir(join(folder, 'documents'), { recursive: true });
  await writeFile(
    join(folder, 'documents', 'report.txt'),
    'Generated document fixture',
  );
  return { root, mapping, folder, reader: new WorkspaceArtifacts(root) };
}
linuxTest(
  'discovers generated workspace documents and transfers their exact bytes with scoped opaque IDs',
  async () => {
    const f = await fixture();
    const artifacts = await f.reader.list(f.mapping);
    expect(artifacts).toMatchObject([
      {
        name: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 26,
        sourcePath: 'documents/report.txt',
      },
    ]);
    const id = artifacts[0]?.id;
    if (!id) throw new Error('Missing document');
    expect(id).not.toContain('/');
    expect(artifacts[0]?.sourcePath).not.toContain(f.root);
    expect(
      (
        await f.reader.download(f.mapping, decodeArtifactId(id))
      ).bytes.toString(),
    ).toBe('Generated document fixture');
  },
);
linuxTest(
  'resolves only relative and exact own native workspace links, never arbitrary sandbox paths or cross-chat destinations',
  async () => {
    const f = await fixture();
    const relative = 'documents/report.txt';
    for (const path of [
      relative,
      `./${relative}`,
      `/home/node/.openclaw/workspace/${f.mapping.agentId}/${relative}`,
      `sandbox:/home/node/.openclaw/workspace/${f.mapping.agentId}/${relative}`,
    ])
      expect(f.reader.sourcePath(f.mapping, path)).toBe(relative);
    for (const path of [
      '../report.txt',
      'documents/../../openclaw.json',
      'documents/%2e%2e/%2e%2e/key.txt',
      'sandbox:/mnt/data/report.txt',
      'file:///etc/passwd',
      'https://host/report.txt',
      '/home/node/.openclaw/workspace/messenger-other/documents/report.txt',
      'documents\\report.txt',
    ])
      expect(() => f.reader.sourcePath(f.mapping, path)).toThrow();
    const other = { agentId: `messenger-${randomUUID()}`, sessionKey: 'wrong' };
    await expect(
      f.reader.download(
        other,
        decodeArtifactId(f.reader.id(f.mapping, relative)),
      ),
    ).rejects.toMatchObject({ status: 404 });
  },
);
linuxTest(
  'excludes symlinks, hardlinks, hidden/bootstrap/key/upload paths and oversized files',
  async () => {
    const f = await fixture();
    await writeFile(join(f.folder, 'AGENTS.md'), 'Private instructions');
    await writeFile(join(f.folder, '.env.txt'), 'PRIVATE_FIXTURE');
    await writeFile(join(f.folder, 'private.key'), 'PRIVATE_FIXTURE');
    await mkdir(join(f.folder, 'uploads'));
    await writeFile(
      join(f.folder, 'uploads', 'user.txt'),
      'Input, not generated',
    );
    await symlink('/etc', join(f.folder, 'documents', 'external'));
    await symlink(
      join(f.folder, 'documents', 'report.txt'),
      join(f.folder, 'documents', 'shortcut.txt'),
    );
    await writeFile(join(f.folder, 'documents', 'hardlinked.txt'), 'Hardlink');
    await link(
      join(f.folder, 'documents', 'hardlinked.txt'),
      join(f.root, 'other-copy.txt'),
    );
    await writeFile(join(f.folder, 'documents', 'large.pdf'), '');
    await truncate(join(f.folder, 'documents', 'large.pdf'), FILE_LIMIT + 1);
    expect((await f.reader.list(f.mapping)).map((item) => item.name)).toEqual([
      'report.txt',
    ]);
    for (const path of [
      'documents/shortcut.txt',
      'documents/external/passwd.txt',
      'documents/hardlinked.txt',
      'documents/large.pdf',
    ])
      await expect(
        f.reader.download(
          f.mapping,
          decodeArtifactId(f.reader.id(f.mapping, path)),
        ),
      ).rejects.toThrow();
    for (const path of ['.env.txt', 'AGENTS.md'])
      expect(() => f.reader.id(f.mapping, path)).toThrow();
  },
);
linuxTest(
  'caps the catalog and accepts safe office archives without serving executable files',
  async () => {
    const f = await fixture();
    for (let i = 0; i < 105; i++)
      await writeFile(
        join(f.folder, 'documents', `report-${i}.docx`),
        'Office fixture',
      );
    await writeFile(join(f.folder, 'documents', 'script.sh'), 'echo unsafe');
    expect(await f.reader.list(f.mapping)).toHaveLength(100);
    await expect(
      f.reader.download(
        f.mapping,
        decodeArtifactId(f.reader.id(f.mapping, 'documents/script.sh')),
      ),
    ).rejects.toThrow();
  },
);
it.skipIf(process.platform === 'linux')(
  'fails closed off Linux instead of using non-atomic pathname containment',
  async () => {
    const f = await fixture();
    await expect(f.reader.list(f.mapping)).rejects.toMatchObject({
      status: 503,
      code: 'WORKSPACE_DOWNLOAD_UNAVAILABLE',
    });
  },
);
