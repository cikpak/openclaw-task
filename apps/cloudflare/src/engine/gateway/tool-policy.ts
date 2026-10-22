import { z } from 'zod';

type Request = (method: string, params: unknown) => Promise<unknown>;
const hash = z.string().min(1).max(256);
const configSchema = z.object({
  valid: z.literal(true),
  hash,
  configRevisionHash: hash.nullable(),
  appliedConfigHash: hash.nullable(),
  config: z.object({
    gateway: z
      .object({
        reload: z.object({ mode: z.string().optional() }).optional(),
      })
      .optional(),
    plugins: z
      .object({
        entries: z
          .object({
            codex: z
              .object({
                config: z
                  .object({
                    codexDynamicToolsLoading: z
                      .enum(['searchable', 'direct'])
                      .optional(),
                  })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});
type Config = z.infer<typeof configSchema>;
const direct = (value: Config) =>
  value.config.plugins?.entries?.codex?.config?.codexDynamicToolsLoading ===
  'direct';
const applied = (value: Config) =>
  value.configRevisionHash !== null &&
  value.configRevisionHash === value.appliedConfigHash;
/** Use native plugin custody; never infer application from a timed-out config write. */
export async function ensureDirectToolLoading(
  request: Request,
): Promise<boolean> {
  const read = async () => {
    const parsed = configSchema.safeParse(await request('config.get', {}));
    return parsed.success ? parsed.data : null;
  };
  const initial = await read();
  if (!initial) return false;
  if (direct(initial) && applied(initial)) return true;
  // No non-CAS plugins.reload: a foreign pending revision could request a restart.
  if (direct(initial) || !applied(initial)) return false;
  const mode = initial.config.gateway?.reload?.mode;
  if (mode !== undefined && !['hot', 'hybrid'].includes(mode)) return false;
  try {
    await request('config.patch', {
      raw: JSON.stringify({
        plugins: {
          entries: {
            codex: { config: { codexDynamicToolsLoading: 'direct' } },
          },
        },
      }),
      baseHash: initial.hash,
    });
  } catch {
    // A failed/timed-out ACK is not application proof. Re-read native state.
  }
  const current = await read();
  return current !== null && direct(current) && applied(current);
}
