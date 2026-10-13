import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';
import { Store } from '../src/database.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import type {
  GatewayAttachment,
  GatewayMapping,
} from '../src/gateway/types.js';
import type { Attachment, ChatSnapshot } from '@messenger/contracts';
import { FILE_LIMIT } from '../src/uploads/validation.js';
import { UploadService } from '../src/uploads/service.js';
import {
  projectArtifacts,
  projectArtifactDownload,
} from '../src/gateway/artifacts.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
async function fixture() {
  const config = parseConfig({
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword('password'),
    SESSION_KEY: 'a'.repeat(64),
    GATEWAY_TOKEN: 'x'.repeat(32),
    APP_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_LOOPBACK: 'true',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'messenger-media-http-')),
  });
  const gateway = new FakeGateway();
  const store = new Store(':memory:');
  const server = await buildServer({ config, gateway, store });
  apps.push(server.app);
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: 'password' },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  return {
    ...server,
    gateway,
    config,
    headers: { cookie, origin: config.origin },
  };
}
function multipart(bytes: Buffer, name = 'note.txt', mime = 'text/plain') {
  const boundary = 'messenger-file-boundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
describe('authenticated upload, delivery and download contracts', () => {
  it('classifies malformed upstream artifact data from the real projector as an internal fault', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    Object.assign(f.gateway, {
      artifacts: (mapping: GatewayMapping) =>
        Promise.resolve(
          projectArtifacts({ artifacts: 'PRIVATE_BAD_UPSTREAM' }, mapping),
        ),
    });
    const response = await f.app.inject({
      url: `/api/chats/${chat.id}/artifacts`,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(response.body).not.toContain('PRIVATE_BAD_UPSTREAM');
    expect(response.body).not.toContain('artifacts');
  });
  it('classifies malformed native download projection as an internal fault without binary headers', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    Object.assign(f.gateway, {
      artifact: (mapping: GatewayMapping) =>
        Promise.resolve(
          projectArtifactDownload(
            { artifact: 'PRIVATE_BAD_UPSTREAM' },
            mapping,
            'native-id',
          ),
        ),
    });
    const response = await f.app.inject({
      url: `/api/chats/${chat.id}/artifacts/opaque-file`,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.body).not.toContain('PRIVATE_BAD_UPSTREAM');
  });
  it.each(['POST', 'DELETE'] as const)(
    'classifies a corrupt stored upload row during valid %s requests as an internal fault',
    async (method) => {
      const f = await fixture();
      const uploadId = randomUUID();
      f.store.db
        .prepare('INSERT INTO uploads VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          uploadId,
          'owner',
          'PRIVATE_BAD_UPLOAD_ROW',
          'text/plain',
          -1,
          method === 'POST' ? 0 : Date.now() + 3600000,
        );
      const form = multipart(Buffer.from('valid upload'));
      const response = await f.app.inject({
        method,
        url: method === 'POST' ? '/api/uploads' : `/api/uploads/${uploadId}`,
        headers: {
          ...f.headers,
          ...(method === 'POST' ? { 'content-type': form.contentType } : {}),
        },
        ...(method === 'POST' ? { payload: form.payload } : {}),
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
      });
      expect(response.headers.location).toBeUndefined();
      expect(response.body).not.toContain('PRIVATE_BAD_UPLOAD_ROW');
      expect(response.body).not.toContain('size');
    },
  );
  it('fails closed before setting creation headers when upload service output violates the public contract', async () => {
    const f = await fixture();
    vi.spyOn(UploadService.prototype, 'create').mockResolvedValueOnce({
      uploadId: 'PRIVATE_RESPONSE_DATA',
      name: 'private/file.txt',
      mimeType: 'text/plain',
      size: 1,
    });
    const form = multipart(Buffer.from('hello'));
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...f.headers, 'content-type': form.contentType },
      payload: form.payload,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(response.headers.location).toBeUndefined();
    expect(response.body).not.toContain('PRIVATE_RESPONSE_DATA');
  });
  it('rejects malformed or private artifact catalog output with a safe internal problem response', async () => {
    const f = await fixture();
    const chat = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    Object.assign(f.gateway, {
      artifacts: () =>
        Promise.resolve([
          {
            id: 'opaque-file',
            name: 'photo.png',
            mimeType: 'image/png',
            sizeBytes: 3,
            secret: 'PRIVATE_RESPONSE_DATA',
          },
        ]),
    });
    const response = await f.app.inject({
      url: `/api/chats/${chat.id}/artifacts`,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
    expect(response.body).not.toContain('PRIVATE_RESPONSE_DATA');
  });
  it.each(['wrong-id', 'size-mismatch', 'non-buffer', 'invalid-metadata'])(
    'rejects %s download service output before binary headers are sent',
    async (failure) => {
      const f = await fixture();
      const chat = await f.chats.create({
        commandId: randomUUID(),
        settings: testSettings,
      });
      const artifact = {
        id: failure === 'wrong-id' ? 'another-file' : 'opaque-file',
        name:
          failure === 'invalid-metadata'
            ? 'PRIVATE_RESPONSE_DATA\r\n'
            : 'photo.png',
        mimeType: 'image/png',
        sizeBytes: failure === 'size-mismatch' ? 4 : 3,
      };
      Object.assign(f.gateway, {
        artifact: () =>
          Promise.resolve({
            artifact,
            bytes:
              failure === 'non-buffer'
                ? 'PRIVATE_RESPONSE_DATA'
                : Buffer.from('png'),
          }),
      });
      const response = await f.app.inject({
        url: `/api/chats/${chat.id}/artifacts/opaque-file`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
      });
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body).not.toContain('PRIVATE_RESPONSE_DATA');
    },
  );
  it('requires an empty deletion outcome and never serializes unexpected service data', async () => {
    const f = await fixture();
    const restore = vi.spyOn(UploadService.prototype, 'remove');
    // Simulate a dependency returning an unexpected runtime value despite its TypeScript signature.
    Object.assign(UploadService.prototype, {
      remove: () => Promise.resolve({ secret: 'PRIVATE_RESPONSE_DATA' }),
    });
    try {
      const response = await f.app.inject({
        method: 'DELETE',
        url: `/api/uploads/${randomUUID()}`,
        headers: f.headers,
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
      });
      expect(response.body).not.toContain('PRIVATE_RESPONSE_DATA');
    } finally {
      restore.mockRestore();
    }
  });
  it('requires authentication, validates multipart limits and returns opaque attachment resources', async () => {
    const f = await fixture();
    const form = multipart(Buffer.from('private attachment'));
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/uploads',
          headers: {
            origin: f.config.origin,
            'content-type': form.contentType,
          },
          payload: form.payload,
        })
      ).statusCode,
    ).toBe(401);
    const uploaded = await f.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...f.headers, 'content-type': form.contentType },
      payload: form.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const file = uploaded.json<Attachment>();
    expect(file).toMatchObject({
      name: 'note.txt',
      mimeType: 'text/plain',
      size: 18,
    });
    expect(uploaded.headers.location).toBe(`/api/uploads/${file.uploadId}`);
    const spoof = multipart(Buffer.from('spoof'), 'photo.png', 'image/png');
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/uploads',
          headers: { ...f.headers, 'content-type': spoof.contentType },
          payload: spoof.payload,
        })
      ).statusCode,
    ).toBe(400);
    const huge = multipart(Buffer.alloc(FILE_LIMIT + 1));
    const oversized = await f.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...f.headers, 'content-type': huge.contentType },
      payload: huge.payload,
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json<{ status: number }>().status).toBe(413);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/uploads/${file.uploadId}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(204);
  });
  it('stores attachment references, preserves queue edit position and sends original bytes only at dispatch', async () => {
    const f = await fixture();
    const form = multipart(Buffer.from('TEXT_FIXTURE_TOKEN'));
    const upload = await f.app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { ...f.headers, 'content-type': form.contentType },
      payload: form.payload,
    });
    const file = upload.json<Attachment>();
    const created = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    f.gateway.ready = false;
    const messageId = randomUUID();
    const accepted = await f.chats.command({
      type: 'conversation.message.send',
      commandId: messageId,
      chatId: created.id,
      text: '',
      uploadIds: [file.uploadId],
    });
    expect(accepted.ok).toBe(true);
    const item = f.store.pending(created.id)[0];
    expect(item?.attachments).toEqual([file]);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/api/uploads/${file.uploadId}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(409);
    const edited = await f.chats.command({
      type: 'conversation.message.editQueued',
      commandId: randomUUID(),
      chatId: created.id,
      messageId,
      revision: 1,
      text: 'corrected',
    });
    expect(edited.ok).toBe(true);
    expect(f.store.pending(created.id)[0]?.position).toBe(item?.position);
    expect(f.store.pending(created.id)[0]?.attachments).toEqual([file]);
    let sentFiles: GatewayAttachment[] = [];
    const send = f.gateway.send.bind(f.gateway);
    f.gateway.send = (
      mapping: GatewayMapping,
      submissionId: string,
      text: string,
      _behavior?: 'queue' | 'steer',
      attachments?: GatewayAttachment[],
    ) => {
      sentFiles = attachments ?? [];
      return send(mapping, submissionId, text);
    };
    f.gateway.ready = true;
    await f.chats.reconcile();
    await f.chats.drain();
    expect(sentFiles[0]?.content).toBe(
      Buffer.from('TEXT_FIXTURE_TOKEN').toString('base64'),
    );
  });
  it('serves authorized artifacts as downloads and scopes every Gateway operation to the selected chat', async () => {
    const f = await fixture();
    const created = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const chat = f.store.getChat(created.id);
    const expected = { agentId: chat.agentId, sessionKey: chat.sessionKey };
    const artifact = {
      id: 'opaque-file',
      name: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    };
    Object.assign(f.gateway, {
      artifacts: (mapping: GatewayMapping) => {
        expect(mapping).toEqual(expected);
        return Promise.resolve([artifact]);
      },
      artifact: (mapping: GatewayMapping, id: string) => {
        expect(mapping).toEqual(expected);
        expect(id).toBe('opaque-file');
        return Promise.resolve({ artifact, bytes: Buffer.from('png') });
      },
    });
    const catalog = await f.app.inject({
      url: `/api/chats/${created.id}/artifacts`,
      headers: f.headers,
    });
    expect(catalog.json()).toEqual({ artifacts: [artifact] });
    const url = `/api/chats/${created.id}/artifacts/opaque-file`;
    expect((await f.app.inject(url)).statusCode).toBe(401);
    const download = await f.app.inject({ url, headers: f.headers });
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('png');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-length']).toBe('3');
    expect(download.headers['cache-control']).toBe('private, no-store');
    expect(
      (
        await f.app.inject({
          url: `/api/chats/${randomUUID()}/artifacts/opaque-file`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('persists bounded tool activity for snapshots and ignores events from unrelated chats', async () => {
    const f = await fixture();
    const created = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    const chat = f.store.getChat(created.id);
    const tool = {
      id: 'run:tool',
      name: 'write',
      status: 'completed' as const,
      parameters: '{"path":"note.txt"}',
      output: 'done',
    };
    const update = new Promise<void>((resolve) => {
      const unsubscribe = f.chats.onEvent((event) => {
        if (event.type === 'conversation.tool') {
          unsubscribe();
          resolve();
        }
      });
    });
    f.gateway.emit({
      type: 'tool',
      sessionKey: chat.sessionKey ?? '',
      runId: 'run',
      sequence: 1,
      tool,
    });
    await update;
    const snapshot: ChatSnapshot = await f.chats.snapshot(created.id);
    expect(snapshot.tools).toContainEqual(tool);
    f.gateway.emit({
      type: 'tool',
      sessionKey: 'unowned-session',
      runId: 'other',
      sequence: 2,
      tool: { ...tool, id: 'private' },
    });
    expect(
      (await f.chats.snapshot(created.id)).tools?.some(
        (entry) => entry.id === 'private',
      ),
    ).toBe(false);
  });
});
