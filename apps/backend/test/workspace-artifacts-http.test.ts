import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '@messenger/contracts';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';
import { Store } from '../src/database.js';
import { FakeGateway, testSettings } from './fake-gateway.js';
import { WorkspaceArtifacts } from '../src/gateway/workspace-artifacts.js';
import { decodeArtifactId } from '../src/gateway/artifacts.js';
import { NotFoundError } from '../src/errors.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-http-'));
  const root = join(directory, 'workspace');
  await mkdir(root);
  const config = parseConfig({
    APP_USERNAME: 'owner',
    APP_PASSWORD_HASH: await hashPassword('password'),
    SESSION_KEY: 'a'.repeat(64),
    GATEWAY_TOKEN: 'x'.repeat(32),
    APP_ORIGIN: 'http://localhost:5173',
    ALLOW_INSECURE_LOOPBACK: 'true',
    DATA_DIR: directory,
  });
  const gateway = new FakeGateway();
  const create = gateway.create.bind(gateway);
  gateway.create = async (id, settings) => {
    const old = await create(id, settings);
    const next = {
      agentId: `messenger-${id}`,
      sessionKey: `agent:messenger-${id}:main`,
    };
    const history = gateway.histories.get(old.sessionKey);
    if (!history) throw new Error('Missing fixture');
    gateway.histories.delete(old.sessionKey);
    gateway.histories.set(next.sessionKey, history);
    return next;
  };
  const reader = new WorkspaceArtifacts(root);
  Object.assign(gateway, {
    artifacts: reader.list.bind(reader),
    artifact: async (
      mapping: Parameters<WorkspaceArtifacts['download']>[0],
      id: string,
    ) => reader.download(mapping, decodeArtifactId(id)),
    resolveArtifact: async (
      mapping: Parameters<WorkspaceArtifacts['sourcePath']>[0],
      path: string,
    ) => {
      const sourcePath = reader.sourcePath(mapping, path);
      const artifact = (await reader.list(mapping)).find(
        (item) => item.sourcePath === sourcePath,
      );
      if (!artifact) throw new NotFoundError();
      return artifact;
    },
  });
  const store = new Store(':memory:');
  const server = await buildServer({ config, gateway, store });
  apps.push(server.app);
  const login = await server.app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { origin: config.origin },
    payload: { username: 'owner', password: 'password' },
  });
  const headers = {
    cookie: String(login.headers['set-cookie']).split(';')[0] ?? '',
    origin: config.origin,
  };
  const chat = await server.chats.create({
    commandId: randomUUID(),
    settings: testSettings,
  });
  const agentId = store.getChat(chat.id).agentId!;
  await mkdir(join(root, agentId, 'documents'), { recursive: true });
  await writeFile(
    join(root, agentId, 'documents', 'report.txt'),
    'Document bytes',
  );
  return { ...server, headers, chat, agentId };
}
it.skipIf(process.platform !== 'linux')(
  'authenticates, resolves only cataloged own-chat paths before opaque route matching, and downloads exact attachment bytes',
  async () => {
    const f = await fixture();
    const path = 'documents/report.txt';
    const url = `/api/chats/${f.chat.id}/artifacts/resolve?path=${encodeURIComponent(path)}`;
    expect((await f.app.inject({ url })).statusCode).toBe(401);
    const resolved = await f.app.inject({ url, headers: f.headers });
    expect(resolved.statusCode).toBe(200);
    const { artifact } = resolved.json<{ artifact: Artifact }>();
    expect(artifact.sourcePath).toBe(path);
    expect(resolved.body).not.toContain('/home/node');
    const downloadUrl = `/api/chats/${f.chat.id}/artifacts/${artifact.id}`;
    expect((await f.app.inject({ url: downloadUrl })).statusCode).toBe(401);
    const download = await f.app.inject({
      url: downloadUrl,
      headers: f.headers,
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.toString()).toBe('Document bytes');
    expect(download.headers['content-disposition']).toContain('attachment;');
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    const other = await f.chats.create({
      commandId: randomUUID(),
      settings: testSettings,
    });
    expect(
      (
        await f.app.inject({
          url: `/api/chats/${other.id}/artifacts/${artifact.id}`,
          headers: f.headers,
        })
      ).statusCode,
    ).toBe(404);
    for (const link of [
      path.replace('report', 'missing'),
      '../keys.txt',
      `/home/node/.openclaw/workspace/messenger-other/${path}`,
      'sandbox:/mnt/data/report.txt',
    ])
      expect(
        (
          await f.app.inject({
            url: `/api/chats/${f.chat.id}/artifacts/resolve?path=${encodeURIComponent(link)}`,
            headers: f.headers,
          })
        ).statusCode,
      ).toBe(404);
    const row = f.store.getChat(f.chat.id);
    row.status = 'deleting';
    f.store.saveChat(row);
    expect(
      (await f.app.inject({ url: downloadUrl, headers: f.headers })).statusCode,
    ).toBe(404);
  },
);
