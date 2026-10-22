export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export const text = (message: Record<string, unknown>): string =>
  typeof message.text === 'string'
    ? message.text
    : typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((part: unknown) => record(part))
            .filter((part) => part?.type === 'text')
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .join('')
        : '';
export function nativeSummary(matches: (value: unknown) => boolean) {
  return (value: unknown) => {
    const item = record(value);
    return item
      ? {
          keys: Object.keys(item),
          idMatches: matches(item.id),
          stableIdPresent: typeof item.id === 'string' && item.id.length > 0,
          positiveSequence: typeof item.seq === 'number' && item.seq > 0,
          runIdMatches: matches(item.runId),
          idempotencyKeyMatches: matches(item.idempotencyKey),
          inputRunIdMatches: matches(item.inputRunId),
          lastRunIdMatches: matches(item.lastRunId),
          activeRunIdMatches: matches(item.activeRunId),
          activeRunIdsIncludeInput:
            Array.isArray(item.activeRunIds) && item.activeRunIds.some(matches),
          hasActiveRun:
            typeof item.hasActiveRun === 'boolean' ? item.hasActiveRun : null,
          cancelled: item.cancelled === true,
          state:
            typeof item.state === 'string' &&
            /^[a-z_-]{1,32}$/u.test(item.state)
              ? item.state
              : null,
        }
      : null;
  };
}

export const journalResult = (fields: Record<string, boolean>) => ({
  accepted: false,
  queryScoped: false,
  pendingReceipt: false,
  cancelledReceipt: false,
  journaledUser: false,
  stableId: false,
  positiveSequence: false,
  ...fields,
});

export function journalReceiptState(
  raw: Record<string, unknown>,
  input: string,
) {
  let pending = false,
    cancelled = false,
    matched = false;
  for (const value of Array.isArray(raw.inputReceipts)
    ? raw.inputReceipts
    : []) {
    const receipt = record(value);
    if (receipt?.runId !== input) continue;
    if (
      matched ||
      typeof receipt.state !== 'string' ||
      !['pending', 'consumed'].includes(receipt.state) ||
      (receipt.cancelled !== undefined &&
        typeof receipt.cancelled !== 'boolean')
    )
      return 'contradiction';
    matched = true;
    cancelled = receipt.cancelled === true;
    pending ||= receipt.state === 'pending';
  }
  return cancelled ? 'cancelled' : pending ? 'pending' : null;
}

export const journalFlag = (flag: string) =>
  journalResult({ accepted: true, queryScoped: true, [flag]: true });
