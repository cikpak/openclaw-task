/** Private canonical processing association. It never grants native authority. */
export const field = 'messengerProcessing';
export function managed(message) {
  const clients = message?.__openclaw?.transport?.clients;
  return (
    message?.role === 'user' &&
    Array.isArray(clients) &&
    clients.some(
      (client) =>
        client?.id === 'gateway-client' &&
        client.mode === 'cli' &&
        client.displayName === 'Messenger manager',
    ) === true
  );
}
export function sourceKey(message) {
  const key = message?.idempotencyKey;
  if (
    message?.role !== 'user' ||
    typeof key !== 'string' ||
    !key.trim() ||
    key !== key.trim()
  )
    throw new Error('Processing source has no exact native input key');
  return key;
}
export function processingPlan(message, sources, runId) {
  if (!sources.some(managed)) return undefined;
  if (typeof runId !== 'string' || !runId.trim() || runId !== runId.trim())
    throw new Error('Processing owner is missing');
  sourceKey(message);
  const keys = [...new Set(sources.map(sourceKey))];
  for (const source of sources) {
    const steer = source.__openclaw?.steerTargetRunId;
    if (steer !== undefined && steer !== runId)
      throw new Error('Processing owner contradicts confirmed native steering');
  }
  return { runId, keys };
}
export function applyProcessing(message, proof) {
  return message && proof
    ? {
        ...message,
        __openclaw: { ...message.__openclaw, [field]: structuredClone(proof) },
      }
    : message;
}
export function restoreProcessing(original, destination) {
  delete destination[field];
  if (original?.[field] !== undefined)
    destination[field] = structuredClone(original[field]);
}
