/** Private authentication material supplements redaction at every browser boundary. */
export async function persistedNativeSecrets(
  storage: Pick<DurableObjectStorage, 'get'>,
): Promise<string[]> {
  const [identity, token] = await Promise.all([
    storage.get<{ privateKey?: JsonWebKey }>('managerIdentity'),
    storage.get<{ token: string }>('deviceToken'),
  ]);
  return [identity?.privateKey?.d ?? '', token?.token ?? ''].filter(Boolean);
}

import type { EngineContext } from '../manager/types.js';
/** The complete known-secret set stays inside the manager for upload/DTO protection. */
export async function managerSecrets(
  context: EngineContext,
): Promise<string[]> {
  const table = context.store.db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'engine_credentials'")
    .get();
  const native = table
    ? (context.store.db
        .prepare('SELECT helper,gateway FROM engine_credentials WHERE id = 1')
        .get() as { helper: string; gateway: string } | undefined)
    : undefined;
  return [
    ...(await persistedNativeSecrets(context.state.storage)),
    native?.helper ?? '',
    native?.gateway ?? '',
    context.env.R2_ACCESS_KEY_ID ?? '',
    context.env.R2_SECRET_ACCESS_KEY ?? '',
    context.env.OPENAI_API_KEY ?? '',
    context.env.ANTHROPIC_API_KEY ?? '',
  ].filter(Boolean);
}

/** Helper audits never receive DO-only R2 credentials or private signing material. */
export async function containerFileSecrets(
  context: EngineContext,
): Promise<string[]> {
  const table = context.store.db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'engine_credentials'")
    .get();
  const native = table
    ? (context.store.db
        .prepare('SELECT helper,gateway FROM engine_credentials WHERE id = 1')
        .get() as { helper: string; gateway: string } | undefined)
    : undefined;
  const token = await context.state.storage.get<{ token: string }>(
    'deviceToken',
  );
  return [
    native?.helper ?? '',
    native?.gateway ?? '',
    token?.token ?? '',
    context.env.OPENAI_API_KEY ?? '',
    context.env.ANTHROPIC_API_KEY ?? '',
  ].filter(Boolean);
}
