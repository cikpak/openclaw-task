import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerConnectionTickets } from '../src/auth/connection-tickets.js';
import { AuthenticationError } from '../src/errors.js';
const origin = 'http://localhost:5173';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function fixture() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof AuthenticationError ? 401 : 500)
      .send({ code: 'REJECTED' }),
  );
  const consume = registerConnectionTickets(
    app,
    (request) => {
      if (typeof request.headers.cookie !== 'string')
        throw new AuthenticationError();
      return request.headers.cookie;
    },
    origin,
  );
  app.get('/admit', { preHandler: consume }, () =>
    Promise.resolve({ ok: true }),
  );
  return app;
}
it('issues a short-lived no-store opaque ticket bound to the authenticated legacy session and consumes it once', async () => {
  const app = fixture();
  const headers = { origin, cookie: 'session-a' };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/connection-tickets',
        headers: { origin },
      })
    ).statusCode,
  ).toBe(401);
  const issued = await app.inject({
    method: 'POST',
    url: '/api/connection-tickets',
    headers,
  });
  expect(issued.headers['cache-control']).toBe('no-store');
  const body = issued.json<{
    ticket: string;
    address: string;
    expiresAt: number;
  }>();
  expect(body.address).toBe('/ws/conversation');
  expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(body.expiresAt).toBeGreaterThan(Date.now());
  expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 60000);
  const url = `/admit?ticket=${body.ticket}`;
  expect((await app.inject({ url, headers })).statusCode).toBe(200);
  expect((await app.inject({ url, headers })).statusCode).toBe(401);
});
it('rejects session mismatch, expiry, and untrusted origin without accepting supplied tickets', async () => {
  const app = fixture();
  const headers = { origin, cookie: 'session-a' };
  const issue = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/connection-tickets',
      headers,
    });
    return response.json<{ ticket: string }>().ticket;
  };
  const mismatched = await issue();
  expect(
    (
      await app.inject({
        url: `/admit?ticket=${mismatched}`,
        headers: { ...headers, cookie: 'session-b' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ url: `/admit?ticket=${mismatched}`, headers }))
      .statusCode,
  ).toBe(401);
  const foreign = await issue();
  expect(
    (
      await app.inject({
        url: `/admit?ticket=${foreign}`,
        headers: { ...headers, origin: 'https://untrusted.example' },
      })
    ).statusCode,
  ).toBe(401);
  const expired = await issue();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
  expect(
    (await app.inject({ url: `/admit?ticket=${expired}`, headers })).statusCode,
  ).toBe(401);
});
