import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeviceIdentity } from '@openclaw/gateway-client';
import { z } from 'zod';
export const gatewayScopes = [
  'operator.read',
  'operator.write',
  'operator.admin',
];
const identitySchema = z.object({
  deviceId: z.string(),
  privateKeyPem: z.string(),
  publicKeyPem: z.string(),
});
export function publicKeyRaw(publicKeyPem: string): string {
  return createPublicKey(publicKeyPem)
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64url');
}
export function loadIdentity(
  dataDir: string,
  publicIdentityFile?: string,
): DeviceIdentity {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'device-identity.json');
  let identity: DeviceIdentity;
  if (existsSync(path))
    identity = identitySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  else {
    const pair = generateKeyPairSync('ed25519');
    const publicKeyPem = pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    identity = {
      deviceId: createHash('sha256')
        .update(Buffer.from(publicKeyRaw(publicKeyPem), 'base64url'))
        .digest('hex'),
      privateKeyPem: pair.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      publicKeyPem,
    };
    writeFileSync(path, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  }
  if (publicIdentityFile) {
    mkdirSync(dirname(publicIdentityFile), { recursive: true });
    writeFileSync(
      publicIdentityFile,
      JSON.stringify({
        deviceId: identity.deviceId,
        publicKey: publicKeyRaw(identity.publicKeyPem),
        role: 'operator',
        scopes: gatewayScopes,
      }),
      { mode: 0o644 },
    );
  }
  return identity;
}
export function signPayload(privateKeyPem: string, payload: string): string {
  return sign(
    null,
    Buffer.from(payload),
    createPrivateKey(privateKeyPem),
  ).toString('base64url');
}
