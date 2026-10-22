import { record } from './acceptance-receipt-shape.js';
type Message = Record<string, unknown>;
type Proof = { runId: string; keys: string[] };
const exact = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;
const metadata = (message: Message) => record(message.__openclaw);
const sequence = (message: Message) => Number(metadata(message)?.seq);
const stable = (message: Message) => {
  const id = metadata(message)?.id;
  return (
    exact(id) &&
    !id.startsWith('pending:') &&
    Number.isSafeInteger(metadata(message)?.seq) &&
    sequence(message) > 0
  );
};
function proof(message: Message): Proof | null {
  const value = record(metadata(message)?.messengerProcessing);
  return value &&
    exact(value.runId) &&
    Array.isArray(value.keys) &&
    value.keys.length > 0 &&
    value.keys.every(exact) &&
    new Set(value.keys).size === value.keys.length
    ? { runId: value.runId, keys: value.keys }
    : null;
}
/** Private association values stay inside this closure; outputs are structural only. */
export function processingEvidence(
  messages: Message[],
  input: string,
  parent?: string,
) {
  const includes = (value: Proof | null) =>
    Boolean(
      value?.keys.some((key) => key === input || key === `${input}:user`),
    );
  let malformed = false,
    contradiction = false;
  const owners = new Map<number, string>();
  let latest: { message: Message; proof: Proof; sequence: number } | undefined;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const meta = metadata(message),
      value = proof(message);
    if (meta?.messengerProcessing !== undefined && !value) malformed = true;
    if (!value || !includes(value)) continue;
    if (
      meta?.steerTargetRunId !== undefined &&
      (!exact(meta.steerTargetRunId) || meta.steerTargetRunId !== value.runId)
    )
      contradiction = true;
    if (!stable(message)) continue;
    const seq = sequence(message),
      prior = owners.get(seq);
    if (prior !== undefined && prior !== value.runId) contradiction = true;
    owners.set(seq, value.runId);
    if (!latest || seq > latest.sequence)
      latest = { message, proof: value, sequence: seq };
  }
  const fields = (message: Message) => {
    const value = message.role === 'user' ? proof(message) : null;
    return {
      processingPresent: metadata(message)?.messengerProcessing !== undefined,
      processingShapeValid: Boolean(value),
      processingSourceCount: value?.keys.length ?? 0,
      processingIncludesInput: includes(value),
      processingOwnerMatchesInput: value?.runId === input,
      processingOwnerMatchesParent: Boolean(parent) && value?.runId === parent,
      processingOwnerDiffersInputAndParent: Boolean(
        parent && value && value.runId !== input && value.runId !== parent,
      ),
      latestProcessingUser: Boolean(latest && message === latest.message),
      runMatchesProcessingOwner: Boolean(
        latest && metadata(message)?.runId === latest.proof.runId,
      ),
      newerThanProcessingUser: Boolean(
        latest && stable(message) && sequence(message) > latest.sequence,
      ),
    };
  };
  const active = (value: unknown) =>
    Boolean(
      latest &&
      (value === latest.proof.runId ||
        record(value)?.runId === latest.proof.runId),
    );
  return {
    fields,
    active,
    summary: {
      processingMalformed: malformed,
      processingContradiction: contradiction,
      processingAssociationPresent: Boolean(latest),
      processingOwnerDiffersInputAndParent: Boolean(
        parent &&
        latest &&
        latest.proof.runId !== input &&
        latest.proof.runId !== parent,
      ),
      processingAssociatedSequenceCount: owners.size,
    },
  };
}
