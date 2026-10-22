import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export async function localEnvironment(
  root = process.cwd(),
  inherited = process.env,
) {
  const id =
    inherited.CLOUDFLARE_WORKSPACE_ID ??
    createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12);
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid workspace identity');
  const frontendPort = Number(
    inherited.FRONTEND_PORT ?? 15000 + (parseInt(id.slice(0, 4), 16) % 10000),
  );
  const harnessPort = Number(inherited.CLOUDFLARE_PORT ?? frontendPort + 1);
  for (const port of [frontendPort, harnessPort])
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('Invalid local port');
  if (frontendPort === harnessPort)
    throw new Error('Frontend and harness need distinct ports');
  const stateDir = resolve(
    inherited.CLOUDFLARE_STATE_DIR ?? `${root}/.context/cloudflare-local/${id}`,
  );
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const secretFile = `${stateDir}/s3-credentials.json`;
  let credentials;
  try {
    credentials = JSON.parse(await readFile(secretFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    credentials = {
      accessKeyId: randomBytes(16).toString('hex'),
      secretAccessKey: randomBytes(32).toString('hex'),
    };
    await writeFile(secretFile, JSON.stringify(credentials), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const envFile = resolve(inherited.MESSENGER_ENV_FILE ?? `${root}/.env`);
  let values;
  try {
    values = parseEnv(await readFile(envFile, 'utf8'));
  } catch {
    throw new Error('Run pnpm setup:env before local development.');
  }
  const merged = { ...values, ...inherited };
  if (!merged.APP_PASSWORD_HASH)
    throw new Error('APP_PASSWORD_HASH is missing');
  const runtime = {
    workspaceId: id,
    stateDir,
    frontendOrigin: `http://127.0.0.1:${frontendPort}`,
    harnessOrigin: `http://127.0.0.1:${harnessPort}`,
    frontendPort,
    harnessPort,
  };
  return {
    runtime,
    env: {
      ...merged,
      X_LOCAL_EXPLORER: 'false',
      X_LOCAL_OBSERVABILITY: 'false',
      APP_ORIGIN: runtime.frontendOrigin,
      CLOUDFLARE_WORKSPACE_ID: id,
      FRONTEND_PORT: String(frontendPort),
      CLOUDFLARE_PORT: String(harnessPort),
      CLOUDFLARE_STATE_DIR: stateDir,
      CLOUDFLARE_PROXY_ORIGIN: runtime.harnessOrigin,
      LOCAL_R2_ACCESS_KEY_ID: credentials.accessKeyId,
      LOCAL_R2_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    },
  };
}
