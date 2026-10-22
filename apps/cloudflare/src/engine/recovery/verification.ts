import { recoveryObjects, type RecoveryDescriptor } from './types.js';
import { hex } from './encoding.js';
export interface VerificationReceipt {
  version: 1;
  checkpointId: string;
  count: number;
  objectsSha256: string;
}
export async function verificationReceipt(
  descriptor: RecoveryDescriptor,
): Promise<VerificationReceipt> {
  const tuples = recoveryObjects(descriptor).map(
    ({ key, size, sha256 }) => [key, size, sha256] as const,
  );
  tuples.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    version: 1,
    checkpointId: descriptor.checkpointId,
    count: tuples.length,
    objectsSha256: hex(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(tuples)),
      ),
    ),
  };
}
export async function assertVerification(
  descriptor: RecoveryDescriptor,
  value: unknown,
): Promise<void> {
  const expected = await verificationReceipt(descriptor);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    Object.entries(expected).some(
      ([key, entry]) => (value as Record<string, unknown>)[key] !== entry,
    )
  )
    throw new Error('Recovery readback verification mismatch');
}
