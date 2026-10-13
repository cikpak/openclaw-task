import { z } from 'zod';
const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATA_DIR: z.string().default('./data'),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  ALLOW_INSECURE_LOOPBACK: z.enum(['true', 'false']).default('false'),
  TRUST_PROXY_HOPS: z.enum(['0', '1']).default('0'),
  APP_USERNAME: z.string().min(1),
  APP_PASSWORD_HASH: z.string().regex(/^scrypt\$[a-f0-9]{32,}\$[a-f0-9]{64,}$/),
  SESSION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  GATEWAY_URL: z.url().default('wss://openclaw:18789'),
  GATEWAY_TOKEN: z.string().min(24),
  GATEWAY_TLS_FINGERPRINT: z.string().optional(),
  GATEWAY_TLS_FINGERPRINT_FILE: z.string().optional(),
  GATEWAY_PUBLIC_IDENTITY_FILE: z.string().optional(),
  GATEWAY_WORKSPACE_DIR: z.string().optional(),
  SESSION_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86400)
    .default(86400),
});
export interface Config {
  trustProxyHops: 0 | 1;
  host: string;
  port: number;
  dataDir: string;
  origin: string;
  secureCookies: boolean;
  username: string;
  passwordHash: string;
  sessionKey: Buffer;
  sessionLifetimeSeconds: number;
  gatewayUrl: string;
  gatewayToken: string;
  gatewayTlsFingerprint?: string;
  gatewayTlsFingerprintFile?: string;
  gatewayPublicIdentityFile?: string;
  gatewayWorkspaceDir?: string;
}
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const p = envSchema.parse(env);
  const origin = new URL(p.APP_ORIGIN);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    origin.hostname,
  );
  if (
    origin.protocol !== 'https:' &&
    !(p.ALLOW_INSECURE_LOOPBACK === 'true' && loopback)
  )
    throw new Error(
      'APP_ORIGIN must use HTTPS or explicitly permitted loopback HTTP.',
    );
  if (!p.GATEWAY_URL.startsWith('wss://'))
    throw new Error('GATEWAY_URL must use encrypted WebSocket transport.');
  return {
    trustProxyHops: p.TRUST_PROXY_HOPS === '1' ? 1 : 0,
    host: p.HOST,
    port: p.PORT,
    dataDir: p.DATA_DIR,
    origin: origin.origin,
    secureCookies: origin.protocol === 'https:',
    username: p.APP_USERNAME,
    passwordHash: p.APP_PASSWORD_HASH,
    sessionKey: Buffer.from(p.SESSION_KEY, 'hex'),
    sessionLifetimeSeconds: p.SESSION_LIFETIME_SECONDS,
    gatewayUrl: p.GATEWAY_URL,
    gatewayToken: p.GATEWAY_TOKEN,
    ...(p.GATEWAY_TLS_FINGERPRINT
      ? { gatewayTlsFingerprint: p.GATEWAY_TLS_FINGERPRINT }
      : {}),
    ...(p.GATEWAY_TLS_FINGERPRINT_FILE
      ? { gatewayTlsFingerprintFile: p.GATEWAY_TLS_FINGERPRINT_FILE }
      : {}),
    ...(p.GATEWAY_PUBLIC_IDENTITY_FILE
      ? { gatewayPublicIdentityFile: p.GATEWAY_PUBLIC_IDENTITY_FILE }
      : {}),
    ...(p.GATEWAY_WORKSPACE_DIR
      ? { gatewayWorkspaceDir: p.GATEWAY_WORKSPACE_DIR }
      : {}),
  };
}
