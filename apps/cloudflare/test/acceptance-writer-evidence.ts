/** Fixed observations only; no process identity can cross the test control. */
export function safeWriterEvidence(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const flags = ['beforeAvailable', 'afterAvailable'];
  const counts = [
    'remainingUid1000',
    'sameGatewayGroup',
    'provenDescendants',
    'unassociatedUid1000',
    'parentIsHelper',
  ];
  if (
    !flags.every((key) => typeof raw[key] === 'boolean') ||
    !counts.every(
      (key) =>
        typeof raw[key] === 'number' &&
        Number.isSafeInteger(raw[key]) &&
        raw[key] >= 0 &&
        raw[key] <= 4096,
    )
  )
    return undefined;
  return Object.fromEntries(
    [...flags, ...counts].map((key) => [key, raw[key]]),
  );
}
