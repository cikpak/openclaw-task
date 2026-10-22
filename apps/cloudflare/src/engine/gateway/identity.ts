import type { GatewayBrowserDeviceIdentity } from '@openclaw/gateway-client/browser';
export const scopes = ['operator.admin', 'operator.read', 'operator.write'];
export interface ExpectedIdentity {
  deviceId: string;
  publicKey: string;
  role: 'operator';
  scopes: string[];
}
export type AuthStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};
type StoredIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: JsonWebKey;
};
const encode = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(
    Array.from(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      (value) => String.fromCharCode(value),
    ).join(''),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
export async function managerIdentity(
  storage: AuthStorage,
): Promise<GatewayBrowserDeviceIdentity> {
  let stored = await storage.get<StoredIdentity>('managerIdentity');
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ]);
    const raw = new Uint8Array(
      await crypto.subtle.exportKey('raw', pair.publicKey),
    );
    stored = {
      deviceId: hex(await crypto.subtle.digest('SHA-256', raw)),
      publicKey: encode(raw),
      privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    };
    await storage.put('managerIdentity', stored);
  }
  if (!stored) throw new Error('Identity persistence failed');
  const key = await crypto.subtle.importKey(
    'jwk',
    stored.privateKey,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const raw = Uint8Array.from(
    atob(stored.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
    (value) => value.charCodeAt(0),
  );
  if (hex(await crypto.subtle.digest('SHA-256', raw)) !== stored.deviceId)
    throw new Error('Invalid durable Gateway identity');
  const verifier = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const proof = new TextEncoder().encode('messenger-identity-validation');
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      verifier,
      await crypto.subtle.sign('Ed25519', key, proof),
      proof,
    ))
  )
    throw new Error('Invalid durable Gateway key pair');
  return {
    deviceId: stored.deviceId,
    publicKey: stored.publicKey,
    sign: async (payload) =>
      encode(
        await crypto.subtle.sign(
          'Ed25519',
          key,
          new TextEncoder().encode(payload),
        ),
      ),
  };
}
