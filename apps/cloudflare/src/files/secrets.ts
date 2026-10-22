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
/** One exact known-secret set protects uploads, helper audits, and browser projection. */
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
