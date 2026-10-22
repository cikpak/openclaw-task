import { describe, expect, it } from 'vitest';
import { recoveryObjectUrl } from './origin.js';
import type { ManagerEnv } from '../../manager/types.js';
const local = 'http://host.docker.internal:8787/cdn-cgi/local/r2/s3';
const env = (R2_ORIGIN: string, LOCAL_R2_EMULATOR?: '1') =>
  ({ R2_ORIGIN, LOCAL_R2_EMULATOR, R2_BUCKET_NAME: 'recovery' }) as ManagerEnv;
describe('private recovery origins', () => {
  it('preserves production HTTPS and constructs the local adapter prefix', () => {
    expect(
      recoveryObjectUrl(
        env('https://abc123.r2.cloudflarestorage.com'),
        'files/a',
      ).href,
    ).toBe('https://abc123.r2.cloudflarestorage.com/recovery/files/a');
    expect(
      recoveryObjectUrl(env(local, '1'), 'staging/uploads/a/content').href,
    ).toBe(`${local}/recovery/staging/uploads/a/content`);
  });
  it.each([
    [local, undefined],
    [local.replace('host.docker.internal', 'localhost'), '1'],
    [
      local.replace(
        'host.docker.internal',
        'host.docker.internal.attacker.test',
      ),
      '1',
    ],
    [local.replace(':8787', ''), '1'],
    [local.replace(':8787', ':80'), '1'],
    [local + '/', '1'],
    [local + '?extra=1', '1'],
    [local + '#fragment', '1'],
    [local.replace('http://', 'http://user@'), '1'],
    [local.replace('/r2/s3', '/r2/other'), '1'],
    ['http://abc123.r2.cloudflarestorage.com', undefined],
    ['https://abc123.r2.cloudflarestorage.com/extra', undefined],
  ])('rejects unsafe origin %s', (origin, flag) => {
    expect(() =>
      recoveryObjectUrl(env(origin, flag as '1' | undefined), 'files/a'),
    ).toThrow();
  });
});
