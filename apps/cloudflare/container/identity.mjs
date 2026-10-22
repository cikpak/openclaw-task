import { createHash } from 'node:crypto';
export const scopes = ['operator.admin', 'operator.read', 'operator.write'];
export function validateIdentity(identity) {
  if (
    !identity ||
    identity.role !== 'operator' ||
    !Array.isArray(identity.scopes) ||
    [...identity.scopes].sort().join(',') !== scopes.join(',')
  )
    throw new Error('Invalid manager identity');
  if (!/^[A-Za-z0-9_-]{43}$/.test(identity.publicKey ?? ''))
    throw new Error('Invalid manager public key');
  const key = Buffer.from(identity.publicKey, 'base64url');
  if (
    key.length !== 32 ||
    createHash('sha256').update(key).digest('hex') !== identity.deviceId
  )
    throw new Error('Invalid device identity');
  if (
    identity.deviceId !==
      (process.env.EXPECTED_MANAGER_DEVICE_ID ??
        process.env.EXPECTED_MANAGER_ID) ||
    identity.publicKey !== process.env.EXPECTED_MANAGER_PUBLIC_KEY
  )
    throw new Error('Unexpected manager identity');
  return identity;
}
export function sameIdentity(left, right) {
  return (
    left?.deviceId === right?.deviceId && left?.publicKey === right?.publicKey
  );
}
