import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
/** Private isolated-harness control, never a deployed application endpoint. */
export async function acceptanceControl(
  action: 'restart-manager' | 'restart-gateway' | 'expire-sessions',
) {
  if (!process.env.ACCEPTANCE_PROJECT?.startsWith('messenger-acceptance-'))
    throw new Error('An isolated acceptance runtime is required');
  await promisify(execFile)(
    'node',
    ['scripts/acceptance-control.mjs', action],
    { timeout: 180_000 },
  );
}

export interface JournalProof {
  cancelledReceipt: boolean;
  pendingReceipt: boolean;
  accepted: boolean;
  journaledUser: boolean;
  stableId: boolean;
  positiveSequence: boolean;
  queryScoped: boolean;
}
/** Test-only fresh native journal oracle; invoked only after the restart. */
export async function acceptanceJournalProof(input: {
  chatId: string;
  commandId: string;
}): Promise<JournalProof | null> {
  if (!process.env.ACCEPTANCE_PROJECT?.startsWith('messenger-acceptance-'))
    throw new Error('An isolated acceptance runtime is required');
  const response = await fetch(
    `${process.env.ACCEPTANCE_HARNESS_ORIGIN}/__acceptance/journal-proof`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (response.status === 503) return null;
  if (!response.ok)
    throw new Error(`Journal proof unavailable (${response.status})`);
  const value = (await response.json()) as Record<string, unknown>;
  const failureFlags = [
    'nativeReadFailed',
    'historyChanged',
    'paginationInvalid',
    'scanIncomplete',
    'receiptContradiction',
  ] as const;
  if (
    failureFlags.some(
      (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
    )
  )
    throw new Error('Invalid journal proof diagnostic flags');
  const rejected = failureFlags.filter((key) => value[key] === true);
  if (rejected.length)
    throw new Error(`Journal proof rejected: ${rejected.join(', ')}`);
  const keys = [
    'cancelledReceipt',
    'pendingReceipt',
    'accepted',
    'journaledUser',
    'stableId',
    'positiveSequence',
    'queryScoped',
  ] as const;
  if (keys.some((key) => typeof value[key] !== 'boolean'))
    throw new Error('Invalid journal proof result');
  return Object.fromEntries(
    keys.map((key) => [key, value[key]]),
  ) as unknown as JournalProof;
}
