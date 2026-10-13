import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/database.js';
import { UploadService } from '../src/uploads/service.js';
import {
  FILE_LIMIT,
  validateFile,
  validateMessageSize,
} from '../src/uploads/validation.js';
import { projectToolEvent } from '../src/gateway/tools.js';
import {
  decodeArtifactId,
  projectArtifactDownload,
  projectArtifacts,
} from '../src/gateway/artifacts.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'messenger-media-'));
  const store = new Store(join(directory, 'db.sqlite'));
  stores.push(store);
  const gateway = new FakeGateway();
  const uploads = new UploadService(store, directory, 'owner', gateway);
  return { directory, store, gateway, uploads };
}
describe('durable bounded uploads', () => {
  it('admits offline attachments only against the exact verified chat scope and refreshes compatibility before delivery', async () => {
    const f = fixture();
    const mapping = await f.gateway.create(randomUUID(), testSettings);
    const uploaded = await f.uploads.create(
      Buffer.from('offline-safe'),
      'text/plain',
      'note.txt',
    );
    const png = await f.uploads.create(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
      'image/png',
      'image.png',
    );
    f.gateway.ready = false;
    const models = f.gateway.models.bind(f.gateway);
    f.gateway.models = () =>
      Promise.reject(new Error('Network lookup must not occur while offline'));
    expect(
      await f.uploads.prepare(testSettings, [uploaded.uploadId], mapping),
    ).toEqual([uploaded]);
    expect(
      await f.uploads.prepare(testSettings, [png.uploadId], mapping),
    ).toEqual([png]);
    await expect(
      f.uploads.prepare(testSettings, [uploaded.uploadId], {
        ...mapping,
        agentId: 'another-agent',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'ATTACHMENT_CAPABILITIES_UNAVAILABLE',
    });
    await expect(
      f.uploads.prepare(
        { ...testSettings, model: 'other/model' },
        [uploaded.uploadId],
        mapping,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: 'ATTACHMENT_MODEL_INCOMPATIBLE',
    });
    f.gateway.ready = true;
    const verified = await models(mapping);
    let queriedScope;
    f.gateway.models = (scope) => {
      queriedScope = scope;
      return Promise.resolve(
        verified.map((model) => ({ ...model, input: ['text'] })),
      );
    };
    await expect(
      f.uploads.payload([png], testSettings, mapping),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_MODEL_INCOMPATIBLE' });
    expect(queriedScope).toEqual(mapping);
    expect(
      (await f.uploads.payload([uploaded], testSettings, mapping))[0]?.content,
    ).toBe(Buffer.from('offline-safe').toString('base64'));
  });
  it('keeps the uploaded file available when a restart has no verified offline capability cache', async () => {
    const f = fixture();
    const uploaded = await f.uploads.create(
      Buffer.from('draft is retained'),
      'text/plain',
      'note.txt',
    );
    const restartedGateway = new FakeGateway();
    restartedGateway.ready = false;
    const restartedUploads = new UploadService(
      f.store,
      f.directory,
      'owner',
      restartedGateway,
    );
    await expect(
      restartedUploads.prepare(testSettings, [uploaded.uploadId], {
        agentId: 'agent',
        sessionKey: 'agent:agent:main',
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: 'ATTACHMENT_CAPABILITIES_UNAVAILABLE',
    });
    expect(
      await readFile(join(f.directory, 'uploads', uploaded.uploadId), 'utf8'),
    ).toBe('draft is retained');
  });
  it('fences deletes and expiry cleanup while admission validates asynchronous capabilities', async () => {
    const f = fixture();
    const uploaded = await f.uploads.create(
      Buffer.from('queued safely'),
      'text/plain',
      'file.txt',
    );
    const catalog = await f.gateway.models();
    let resolveModels!: (value: typeof catalog) => void;
    f.gateway.models = () =>
      new Promise((resolve) => {
        resolveModels = resolve;
      });
    const prepare = f.uploads.prepare(testSettings, [uploaded.uploadId]);
    await expect(f.uploads.remove(uploaded.uploadId)).rejects.toMatchObject({
      code: 'UPLOAD_IN_USE',
    });
    f.store.db.prepare('UPDATE uploads SET expires_at = 0').run();
    await f.uploads.cleanup();
    expect(
      await readFile(join(f.directory, 'uploads', uploaded.uploadId), 'utf8'),
    ).toBe('queued safely');
    resolveModels(catalog);
    expect(await prepare).toEqual([uploaded]);
    await nextTurn();
    await f.uploads.cleanup();
    await expect(
      readFile(join(f.directory, 'uploads', uploaded.uploadId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects admission once removal has started, before asynchronous unlink finishes', async () => {
    const f = fixture();
    const uploaded = await f.uploads.create(
      Buffer.from('delete safely'),
      'text/plain',
      'file.txt',
    );
    const removing = f.uploads.remove(uploaded.uploadId);
    await expect(
      f.uploads.prepare(testSettings, [uploaded.uploadId]),
    ).rejects.toMatchObject({ code: 'UPLOAD_REMOVING' });
    await removing;
  });
  it('uses opaque private storage and retains account ownership across sessions/restarts', async () => {
    const f = fixture();
    const uploaded = await f.uploads.create(
      Buffer.from('private text'),
      'text/plain',
      '../../private\r\n.txt',
    );
    expect(uploaded.name).toBe('private.txt');
    expect(
      await readFile(join(f.directory, 'uploads', uploaded.uploadId), 'utf8'),
    ).toBe('private text');
    const restarted = new UploadService(
      f.store,
      f.directory,
      'owner',
      f.gateway,
    );
    expect(await restarted.prepare(testSettings, [uploaded.uploadId])).toEqual([
      uploaded,
    ]);
    const otherOwner = new UploadService(
      f.store,
      f.directory,
      'another',
      f.gateway,
    );
    await expect(
      otherOwner.prepare(testSettings, [uploaded.uploadId]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      restarted.prepare(testSettings, [uploaded.uploadId, uploaded.uploadId]),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ATTACHMENT' });
  });
  it('rejects spoofed bytes, invalid UTF-8, unsupported MIME and expanded Gateway limits', () => {
    expect(() => validateFile(Buffer.from('not png'), 'image/png')).toThrow();
    expect(() => validateFile(Buffer.from([255, 254]), 'text/plain')).toThrow();
    expect(() => validateFile(Buffer.from('hello'), 'text/html')).toThrow();
    expect(() =>
      validateFile(Buffer.alloc(FILE_LIMIT + 1), 'text/plain'),
    ).toThrow();
    expect(() => validateMessageSize([FILE_LIMIT, FILE_LIMIT, 1])).toThrow();
    expect(() => validateMessageSize([1000000], 1500000)).toThrow();
    expect(() => validateMessageSize([1, 1, 1, 1, 1, 1])).toThrow();
  });
  it('retains queued and unknown attachments beyond expiry and cleans them only after resolution', async () => {
    const f = fixture();
    const uploaded = await f.uploads.create(
      Buffer.from('# retained'),
      'text/markdown',
      'note.md',
    );
    const id = randomUUID();
    f.store.reserveChat({
      id,
      name: 'Retained',
      status: 'recovery',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      settings: testSettings,
      agentId: 'agent',
      sessionKey: 'agent:agent:main',
      creationId: randomUUID(),
    });
    const messageId = randomUUID();
    f.store.savePending({
      id: messageId,
      chatId: id,
      position: 1,
      text: '',
      attachments: [uploaded],
      revision: 1,
      state: 'unknown',
      submissionId: messageId,
      createdAt: 1,
    });
    f.store.db.prepare('UPDATE uploads SET expires_at = 0').run();
    await f.uploads.cleanup();
    expect((await f.uploads.payload([uploaded]))[0]?.content).toBe(
      Buffer.from('# retained').toString('base64'),
    );
    await expect(f.uploads.remove(uploaded.uploadId)).rejects.toMatchObject({
      code: 'UPLOAD_IN_USE',
    });
    f.store.removePending(messageId);
    await f.uploads.cleanup();
    await expect(f.uploads.payload([uploaded])).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      readFile(join(f.directory, 'uploads', uploaded.uploadId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects images on text-only models but passes text/PDF through the verified file pipeline', async () => {
    const f = fixture();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const image = await f.uploads.create(png, 'image/png', 'image.png');
    const originalModels = await f.gateway.models();
    f.gateway.models = () =>
      Promise.resolve(
        originalModels.map((model) => ({ ...model, input: ['text'] })),
      );
    await expect(
      f.uploads.prepare(testSettings, [image.uploadId]),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_MODEL_INCOMPATIBLE' });
    const pdf = await f.uploads.create(
      Buffer.from('%PDF-1.7\nfixture'),
      'application/pdf',
      'doc.pdf',
    );
    expect(await f.uploads.prepare(testSettings, [pdf.uploadId])).toEqual([
      pdf,
    ]);
    expect((await f.uploads.payload([pdf]))[0]).toMatchObject({
      type: 'file',
      mimeType: 'application/pdf',
      origin: 'file',
    });
  });
  it('expires unused uploads and safely reports missing content without leaking paths', async () => {
    const f = fixture();
    const uploaded = await f.uploads.create(
      Buffer.from('unused'),
      'text/plain',
      'note.txt',
    );
    f.store.db.prepare('UPDATE uploads SET expires_at = 0').run();
    await expect(
      f.uploads.prepare(testSettings, [uploaded.uploadId]),
    ).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    await f.uploads.cleanup();
    await expect(f.uploads.remove(uploaded.uploadId)).rejects.toMatchObject({
      status: 404,
    });
  });
});
describe('safe tool activity and scoped artifact projection', () => {
  const mapping = { agentId: 'agent-a', sessionKey: 'agent:agent-a:main' };
  const artifact = {
    id: 'transcript-image:one',
    title: '../../photo.png',
    mimeType: 'image/png',
    sizeBytes: 3,
    sessionKey: mapping.sessionKey,
    download: { mode: 'bytes' },
  };
  it('normalizes actual tool events, bounds previews and redacts sensitive properties', () => {
    const event = projectToolEvent({
      stream: 'tool',
      sessionKey: mapping.sessionKey,
      runId: 'run',
      seq: 1,
      data: {
        phase: 'result',
        toolCallId: 'call',
        name: 'web_fetch',
        args: { url: 'https://example.com', authorization: 'private' },
        result: 'x'.repeat(20000),
        isError: true,
      },
    });
    expect(event?.tool.status).toBe('failed');
    expect(event?.tool.parameters).not.toContain('private');
    expect(event?.tool.parameters).toContain('[redacted]');
    expect(event?.tool.output).toHaveLength(8192);
    expect(projectToolEvent({ stream: 'tool' })).toBeNull();
    expect(
      projectToolEvent({
        stream: 'tool',
        sessionKey: mapping.sessionKey,
        runId: 'run',
        seq: 1,
        data: { phase: 'start', toolCallId: 'call', name: 'exec' },
      }),
    ).toBeNull();
  });
  it('filters cross-chat artifacts and round-trips only opaque artifact identities', () => {
    const catalog = projectArtifacts(
      {
        artifacts: [
          artifact,
          { ...artifact, id: 'private-other', sessionKey: 'other' },
        ],
      },
      mapping,
    );
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.name).toBe('photo.png');
    expect(decodeArtifactId(catalog[0]?.id ?? '')).toBe(artifact.id);
    expect(() => decodeArtifactId('../../secret')).toThrow();
    const result = projectArtifactDownload(
      {
        artifact,
        encoding: 'base64',
        data: Buffer.from('png').toString('base64'),
      },
      mapping,
      artifact.id,
    );
    expect(result.bytes.toString()).toBe('png');
    expect(() =>
      projectArtifactDownload(
        {
          artifact: { ...artifact, sessionKey: 'other' },
          encoding: 'base64',
          data: 'cG5n',
        },
        mapping,
        artifact.id,
      ),
    ).toThrow();
    expect(() =>
      projectArtifactDownload(
        { artifact, encoding: 'base64', data: 'malformed' },
        mapping,
        artifact.id,
      ),
    ).toThrow();
  });
  it('never follows URL-only artifacts and returns a safe explicit limitation', () => {
    expect(() =>
      projectArtifactDownload(
        {
          artifact: { ...artifact, download: { mode: 'url' } },
          url: 'http://localhost/private',
        },
        mapping,
        artifact.id,
      ),
    ).toThrow('cannot safely transfer');
  });
});
