import { expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { localRequestAllowed } from '../config/local-boundary.js';
const bucket = 'openclaw-local-abcdefabcdef-recovery';
const signed = `/cdn-cgi/local/r2/s3/${bucket}/recovery/generation/archive.tar.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=local&X-Amz-Signature=${'a'.repeat(64)}`;
const request = (url: string, peer: string, method = 'GET') =>
  ({
    url,
    method,
    headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: peer },
  }) as unknown as IncomingMessage;
it('uses actual peers and denies native control routes for every peer', () => {
  for (const peer of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '192.168.1.2',
    '172.17.0.2',
  ]) {
    for (const path of [
      '/cdn-cgi/local/explorer/api/local/workers',
      '/cdn-cgi/local/platform-proxy',
      '/cdn-cgi/local/explorer/',
      '/%63dn-cgi/local/explorer/api',
      '/cdn-cgi/local/r2/s3/../explorer/api',
      '/cdn-cgi/local/%65xplorer/api',
      '/cdn-cgi/local/explorer%2fapi',
      '/cdn-cgi/local/%252e%252e/explorer/api',
    ])
      expect(
        localRequestAllowed(request(path, peer), bucket),
        `${peer}:${path}`,
      ).toBe(false);
  }
  expect(
    localRequestAllowed(request('/api/session', '127.0.0.1'), bucket),
  ).toBe(true);
  expect(
    localRequestAllowed(request('/api/session', '192.168.1.2'), bucket),
  ).toBe(false);
});
it('permits only exact signed workspace S3 transfers and rejects traversal or unsigned requests', () => {
  for (const peer of ['127.0.0.1', '172.17.0.2']) {
    expect(localRequestAllowed(request(signed, peer), bucket)).toBe(true);
    expect(localRequestAllowed(request(signed, peer, 'PUT'), bucket)).toBe(
      true,
    );
    for (const path of [
      signed.split('?')[0]!,
      signed.replace(bucket, 'other-bucket'),
      signed.replace('/recovery/', '/%2frecovery/'),
      signed.replace('/recovery/', '/recovery/../'),
      signed.replace('/recovery/', '/recovery//'),
      signed.replace('/recovery/', '/recovery/%5c'),
      signed.replace('/recovery/', '/recovery/%252e%252e/'),
    ])
      expect(localRequestAllowed(request(path, peer), bucket), path).toBe(
        false,
      );
    expect(localRequestAllowed(request(signed, peer, 'DELETE'), bucket)).toBe(
      false,
    );
  }
});
it('denies all non-loopback upgrades before application or HMR listeners', () => {
  for (const path of [
    '/ws/conversation',
    '/?vite-hmr',
    '/cdn-cgi/local/explorer',
    signed,
  ]) {
    expect(
      localRequestAllowed(request(path, '192.168.1.2'), bucket, true),
    ).toBe(false);
    expect(localRequestAllowed(request(path, '127.0.0.1'), bucket, true)).toBe(
      !path.startsWith('/cdn-cgi/'),
    );
  }
});
