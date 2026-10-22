import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { scryptSync } from 'node:crypto';

export const origin = 'https://messenger.example';
const salt = 'b640963416b41c4eaa7002ed39c35492';
const passwordHash = `scrypt$${salt}$${scryptSync('runtime-password', Buffer.from(salt, 'hex'), 64).toString('hex')}`;
const scripts = new Map();
async function bundle(path) {
  if (!scripts.has(path)) {
    const result = await build({
      entryPoints: [path],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external: ['node:*', 'cloudflare:*'],
      write: false,
    });
    scripts.set(path, result.outputFiles[0].text);
  }
  return scripts.get(path);
}
export async function runtime({
  backendUnavailable = false,
  probe = false,
  storageRoot,
  r2 = false,
} = {}) {
  const common = {
    modules: true,
    compatibilityDate: '2026-10-22',
    compatibilityFlags: ['nodejs_compat'],
  };
  const logs = [];
  class CapturedLog extends Log {
    log(message) {
      logs.push(message);
    }
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      ...(storageRoot ? { resourcePersistencePath: storageRoot } : {}),
      log: new CapturedLog(LogLevel.INFO),
      handleStructuredLogs: (entry) => logs.push(entry.message),
      workers: [
        {
          ...common,
          name: 'facade',
          script: await bundle('src/facade.ts'),
          serviceBindings: { BACKEND: 'backend', MANAGER: 'manager' },
        },
        {
          ...common,
          name: 'backend',
          script: await bundle('src/auth/worker.ts'),
          d1Databases: { AUTH_DB: 'auth' },
          serviceBindings: { MANAGER: 'manager' },
          bindings: {
            APP_ORIGIN: origin,
            APP_USERNAME: 'owner',
            APP_PASSWORD_HASH: passwordHash,
            SESSION_TTL_SECONDS: '86400',
          },
        },
        {
          ...common,
          name: 'manager',
          script: probe
            ? await managerProbe()
            : await bundle('src/manager/worker.ts'),
          serviceBindings: {
            BACKEND: backendUnavailable ? 'unavailable' : 'backend',
          },
          durableObjects: {
            MANAGERS: { className: 'ConversationManager', useSQLite: true },
          },
          ...(r2
            ? { r2Buckets: { RECOVERY_BUCKET: 'manager-test-uploads' } }
            : {}),
          bindings: { APP_ORIGIN: origin, MANAGER_ID: 'primary' },
        },
        {
          ...common,
          name: 'unavailable',
          script:
            'export default {fetch(){ return new Response(null,{status:503}); }}',
        },
      ],
    }),
  );
  const db = await mf.getD1Database('AUTH_DB', 'backend');
  const migration = await readFile(
    new URL('../migrations/0001_auth.sql', import.meta.url),
    'utf8',
  );
  // D1 exec treats each line as a statement; migration SQL intentionally spans lines.
  const initialized = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'",
    )
    .first();
  if (!initialized)
    for (const statement of migration
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  const backend = await mf.getWorker('backend');
  return {
    mf,
    logs,
    db,
    backend,
    public: (path, options = {}) =>
      mf.dispatchFetch(`${origin}${path}`, options),
    private: (path, value) =>
      backend.fetch(`https://backend${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
  };
}
let loginAddress = 0;
export async function login(app) {
  const response = await app.public('/api/session', {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      'CF-Connecting-IP': `192.0.2.${++loginAddress}`,
    },
    body: JSON.stringify({ username: 'owner', password: 'runtime-password' }),
  });
  if (response.status !== 200)
    throw Error(`Login failed: ${response.status} ${await response.text()}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return {
    cookie,
    sessionToken: cookie.slice(cookie.indexOf('=') + 1),
    response,
  };
}
export async function ticket(app, cookie) {
  const response = await app.public('/api/connection-tickets', {
    method: 'POST',
    headers: { origin, cookie },
  });
  if (response.status !== 200)
    throw Error(`Ticket failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function managerProbe() {
  const result = await build({
    stdin: {
      contents: `
    import worker, {ConversationManager as Actual} from './src/manager/worker.ts';
    import {managerCommandSchema} from '../backend/src/transport/manager-schema.ts';
    export class ConversationManager extends Actual {
      testCommandLedger() {
        return this.ctx.storage.sql.exec('SELECT id,json FROM manager_command_inputs ORDER BY id').toArray();
      }
      testLegacyCommand(command) {
        this.ctx.storage.sql.exec('UPDATE manager_command_inputs SET json=? WHERE id=?',JSON.stringify(managerCommandSchema.parse(command)),command.commandId);
      }
      testCommandOwner(commandId,accountId) {
        if(accountId!==undefined)this.ctx.storage.sql.exec("UPDATE manager_resources SET account_id=? WHERE kind='command' AND id=?",accountId,commandId);
        return this.ctx.storage.sql.exec("SELECT account_id FROM manager_resources WHERE kind='command' AND id=?",commandId).toArray()[0].account_id;
      }
      async testRenew() {
        for(const socket of this.ctx.getWebSockets()){const value=socket.deserializeAttachment();value.renewAt=0;socket.serializeAttachment(value);}
        await super.alarm();
      }
      async testExpire() {
        for(const socket of this.ctx.getWebSockets()){const value=socket.deserializeAttachment();value.grant.expiresAt=0;socket.serializeAttachment(value);}
        await super.alarm();
      }
    }
    export default worker;`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['node:*', 'cloudflare:*'],
    write: false,
  });
  return result.outputFiles[0].text;
}
