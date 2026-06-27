import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { authHeaders } from './helpers/auth.js';
import { resetConfig } from '../../config/env.js';
import { getDiscoveryFixture } from '../../../tests/helpers/oidc-fixtures.js';

// Configure low limits BEFORE importing server-builder
process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';

/**
 * Rate limit hardening (task #182): @fastify/rate-limit returns 429 after
 * the configured threshold of requests from the same IP, except for /health
 * which is allow-listed.
 */
describe('API rate limiting', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let auth: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    auth = authHeaders(result.app.db);
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_TIME_WINDOW;
  });

  it('returns 429 after the 3-request threshold from the same IP', async () => {
    const headers = auth;

    const r1 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });
    const r2 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });
    const r3 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });
    const r4 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });

    // First 3 succeed, 4th is throttled
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
    expect(r4.statusCode).toBe(429);

    const body = JSON.parse(r4.body);
    expect(body.error).toBe('TOO_MANY_REQUESTS');
    expect(body.message).toMatch(/Rate limit exceeded/);
  });

  it('throttles repeated INVALID auth attempts to 429 (brute-force defence)', async () => {
    // After the above 4 requests, the limiter window is still open. Further
    // requests — even with wrong key — should hit 429 BEFORE reaching auth.
    // This is the brute-force defence: the limiter caps the supply of guesses
    // regardless of whether they pass auth.
    const bad = { 'x-api-key': 'this-is-not-the-right-key' };
    const r = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: bad });
    expect(r.statusCode).toBe(429);
  });

  it('does NOT rate-limit /health (allow-listed)', async () => {
    // Health is exempt — even repeated calls should always pass through to
    // the health route. We hit it more than `max` times.
    for (let i = 0; i < 10; i++) {
      const r = await server.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).not.toBe(429);
    }
  });
});

/**
 * Issue #75 — proxy-aware keying. With `TRUST_PROXY` set, Fastify resolves
 * `request.ip` from `X-Forwarded-For`, so two clients behind the SAME proxy
 * land in SEPARATE rate-limit buckets (one hitting its limit must not 429
 * the other). With `TRUST_PROXY` OFF (default), a spoofed `X-Forwarded-For`
 * MUST NOT change the bucket — both requests share the socket-IP bucket.
 *
 * These suites build their own server with a distinct env so they don't
 * collide with the module-level RATE_LIMIT_MAX=3 above. resetConfig() drops
 * the cached config so the new env (TRUST_PROXY, low global max) is read.
 */
describe('proxy-aware rate limiting (trustProxy ON)', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    process.env.TRUST_PROXY = 'true';
    resetConfig();
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_TIME_WINDOW;
    delete process.env.TRUST_PROXY;
    resetConfig();
  });

  it('gives two clients behind a TRUSTED proxy SEPARATE buckets', async () => {
    // Client A (1.1.1.1) burns its budget. Use UNAUTHENTICATED requests so
    // the keyGenerator falls through to request.ip (resolved from XFF).
    const a = { 'x-forwarded-for': '1.1.1.1' };
    const b = { 'x-forwarded-for': '2.2.2.2' };

    const a1 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: a });
    const a2 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: a });
    const a3 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: a });
    // A's 3rd request exceeds max=2 → 429 for A.
    expect(a3.statusCode).toBe(429);
    // First two consumed A's budget but did not reach 429.
    expect(a1.statusCode).not.toBe(429);
    expect(a2.statusCode).not.toBe(429);

    // Client B is in a DIFFERENT bucket — its first request must NOT be 429
    // even though A is already throttled.
    const b1 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: b });
    expect(b1.statusCode).not.toBe(429);
  });
});

describe('rate limiting with trustProxy OFF (spoof-resistant)', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    // TRUST_PROXY intentionally UNSET → default false.
    delete process.env.TRUST_PROXY;
    resetConfig();
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_TIME_WINDOW;
    resetConfig();
  });

  it('a spoofed X-Forwarded-For does NOT change the bucket', async () => {
    // Every request claims a DIFFERENT X-Forwarded-For. With trustProxy OFF,
    // request.ip stays the socket IP (127.0.0.1 under inject) for all of
    // them, so they share ONE bucket and the 3rd (> max=2) is throttled.
    const r1 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    const r2 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    const r3 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { 'x-forwarded-for': '10.0.0.3' },
    });
    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    // Spoofing a fresh XFF did NOT buy a fresh bucket.
    expect(r3.statusCode).toBe(429);
  });
});

describe('per-route auth rate limit (tighter than global)', () => {
  // The real /auth/device/code route (with its per-route rateLimit config)
  // only mounts when OIDC is ENABLED — the disabled-mode stub carries no
  // per-route budget. Boot the server in OIDC-enabled mode (nock-mocked
  // discovery, same pattern as oidc-enabled-boot.test.ts) so the per-route
  // limit is exercised, not the global one.
  const ISSUER = 'https://accounts.example.com';
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    // Global budget high; the per-route auth budget is the binding limit.
    process.env.RATE_LIMIT_MAX = '1000';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    process.env.RATE_LIMIT_AUTH_MAX = '3';
    process.env.RATE_LIMIT_AUTH_TIME_WINDOW = '1 minute';
    process.env.OIDC_ISSUER_URL = ISSUER;
    process.env.OIDC_CLIENT_ID = 'test-client-id.example.com';
    process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
    process.env.OIDC_REDIRECT_URI = 'https://wft.example.com/auth/callback';
    process.env.OIDC_SCOPES = 'openid email profile';
    process.env.SESSION_COOKIE_SECRET = randomBytes(32).toString('base64');
    resetConfig();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
    nock(ISSUER).get('/.well-known/openid-configuration').reply(200, getDiscoveryFixture());

    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_TIME_WINDOW;
    delete process.env.RATE_LIMIT_AUTH_MAX;
    delete process.env.RATE_LIMIT_AUTH_TIME_WINDOW;
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_REDIRECT_URI;
    delete process.env.OIDC_SCOPES;
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
  });

  it('throttles /auth/device/code at its tighter per-route budget (3) below global (1000)', async () => {
    // POST /auth/device/code is anonymous (skipAuth) so all calls key on the
    // same socket IP. The per-route max=3 binds well before global=1000.
    const body = { client_id: 'wft-cli' };
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await server.inject({ method: 'POST', url: '/auth/device/code', payload: body });
      codes.push(r.statusCode);
    }
    // First 3 succeed (200) — below the route's budget; the 4th onward is 429.
    expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
    expect(codes[3]).toBe(429);
    expect(codes[4]).toBe(429);
  });
});
