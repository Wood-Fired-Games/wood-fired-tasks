import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import nock from 'nock';
import { createServer, rateLimitKeyGenerator, RATE_LIMIT_IP_MAX_FACTOR } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { authHeaders, seedAuth } from './helpers/auth.js';
import { resetConfig } from '../../config/env.js';
import { getDiscoveryFixture } from '../../../tests/helpers/oidc-fixtures.js';

// Configure low limits BEFORE importing server-builder
process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';

/**
 * Rate limit hardening (task #182): @fastify/rate-limit returns 429 after
 * the configured threshold of requests from the same IP, except for /health
 * which is allow-listed.
 *
 * Audit H2 (2026-07-26) — TWO independent layers are registered in
 * `server.ts`: an `onRequest`-phase, IP-keyed layer (pre-auth, generous
 * budget — see `RATE_LIMIT_IP_MAX_FACTOR`) that preserves brute-force
 * defence for unauthenticated/invalid-credential traffic, and a
 * `preHandler`-phase, principal-keyed layer (post-auth, the tight
 * `RATE_LIMIT_MAX` budget) that is the actual H2 fix — see
 * `rateLimitKeyGenerator` in `server.ts`. This describe block exercises the
 * principal-keyed layer; the dedicated describes further down exercise the
 * IP-keyed layer in isolation (each with its own low-budget server so
 * deliberately exhausting one layer's bucket can't bleed into another test).
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

  it('does NOT rate-limit /health (allow-listed)', async () => {
    // Health is exempt — even repeated calls should always pass through to
    // the health route. We hit it more than `max` times.
    for (let i = 0; i < 10; i++) {
      const r = await server.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).not.toBe(429);
    }
  });

  it('gives two distinct valid tokens from the SAME source IP independent budgets', async () => {
    // Audit H2 — before the fix, keyGenerator ran at `onRequest` (before the
    // auth chain's preHandler decorated `request.tokenId`), so EVERY
    // request — regardless of which token authenticated it — fell through
    // to the `ip:` branch and shared one bucket. Two distinct PATs hitting
    // server.inject (which always presents as 127.0.0.1) now MUST land in
    // separate `tok:<id>` buckets. (The IP-keyed layer 1 budget is 20x this
    // describe's RATE_LIMIT_MAX, so it stays comfortably unconsumed by the
    // handful of requests below — see RATE_LIMIT_IP_MAX_FACTOR.)
    const tokenA = seedAuth(db, { displayName: 'tenant-a', name: 'token-a' });
    const tokenB = seedAuth(db, { displayName: 'tenant-b', name: 'token-b' });

    // Exhaust token A's budget (max=3 for this describe block).
    const a1 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: tokenA.headers,
    });
    const a2 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: tokenA.headers,
    });
    const a3 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: tokenA.headers,
    });
    const a4 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: tokenA.headers,
    });
    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(200);
    expect(a3.statusCode).toBe(200);
    expect(a4.statusCode).toBe(429); // token A's budget is now exhausted

    // Token B's FIRST request, from the same source IP, must NOT be 429 —
    // it has its own independent budget.
    const b1 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: tokenB.headers,
    });
    expect(b1.statusCode).toBe(200);
  });

  it("keys an authenticated request as 'tok:<id>'/'usr:<id>', not 'ip:<addr>'", () => {
    // Direct unit check on the exported keyGenerator (Audit H2 AC): given a
    // request-shaped object with a decorated `tokenId` (as the auth chain's
    // preHandler would have set by the time this now runs, per the layer-2
    // `hook: 'preHandler'` registration), the key must be principal-based.
    const authenticatedKey = rateLimitKeyGenerator({ tokenId: 42, user: null, ip: '127.0.0.1' });
    expect(authenticatedKey).toBe('tok:42');
    expect(authenticatedKey.startsWith('tok:') || authenticatedKey.startsWith('usr:')).toBe(true);
    expect(authenticatedKey.startsWith('ip:')).toBe(false);

    // Session-authenticated (no tokenId, but a user) also keys by principal.
    const sessionKey = rateLimitKeyGenerator({ tokenId: null, user: { id: 7 }, ip: '127.0.0.1' });
    expect(sessionKey).toBe('usr:7');

    // Unauthenticated (no tokenId, no user) still falls back to `ip:`.
    const anonKey = rateLimitKeyGenerator({ tokenId: null, user: null, ip: '127.0.0.1' });
    expect(anonKey).toBe('ip:127.0.0.1');
  });
});

/**
 * Audit H2 process correction — the first cut of this fix moved the ONLY
 * rate-limit registration to `hook: 'preHandler'`, which let the auth
 * chain's 401 short-circuit the hook chain before the limiter ever ran for
 * invalid/missing credentials, silently deleting brute-force protection.
 * The restored fix adds a SEPARATE, `onRequest`-phase, IP-keyed layer (see
 * `RATE_LIMIT_IP_MAX_FACTOR` in server.ts) that unconditionally runs BEFORE
 * auth, so repeated invalid-credential/unauthenticated traffic from one
 * source IP is still throttled to 429 regardless of auth outcome.
 *
 * Each describe below boots its own low-budget server (RATE_LIMIT_MAX=2, so
 * the IP-keyed layer's budget is 2 * RATE_LIMIT_IP_MAX_FACTOR) so
 * deliberately exhausting the pre-auth bucket in one test can't bleed into
 * another.
 */
describe('IP-keyed pre-auth rate limiting (Layer 1): brute-force defence', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let ipMax: number;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    delete process.env.TRUST_PROXY;
    resetConfig();
    ipMax = 2 * RATE_LIMIT_IP_MAX_FACTOR;
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

  it('throttles repeated INVALID auth attempts to 429 (brute-force defence) — restored', async () => {
    // Every attempt carries a bad credential, so auth would reject ALL of
    // them (401) if the request ever reached it. The IP-keyed layer runs
    // BEFORE auth, so once its (generous) budget is exhausted, subsequent
    // attempts are 429'd without auth ever running — proving credential
    // guessing is still capped regardless of whether any individual guess
    // would have passed auth.
    const bad = { 'x-api-key': 'this-is-not-the-right-key' };
    const codes: number[] = [];
    for (let i = 0; i < ipMax + 1; i++) {
      const r = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: bad });
      codes.push(r.statusCode);
    }

    // First `ipMax` attempts reach auth and are rejected on their own merits.
    expect(codes.slice(0, ipMax).every((c) => c === 401)).toBe(true);
    // The next one is throttled by the IP-keyed layer BEFORE auth runs.
    expect(codes[ipMax]).toBe(429);

    const throttled = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: bad,
    });
    const body = JSON.parse(throttled.body);
    expect(body.error).toBe('TOO_MANY_REQUESTS');
    expect(body.message).toMatch(/Rate limit exceeded/);
  });
});

describe('IP-keyed pre-auth rate limiting (Layer 1): fully unauthenticated traffic', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let ipMax: number;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    delete process.env.TRUST_PROXY;
    resetConfig();
    ipMax = 2 * RATE_LIMIT_IP_MAX_FACTOR;
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

  it('an UNAUTHENTICATED request is still IP-keyed and still reaches 429 once its budget is exceeded', async () => {
    // No Authorization / X-Api-Key header at all — the auth chain's
    // catch-all ('missing_credential') would 401 every one of these if they
    // reached it. Same property as the invalid-credential case above,
    // exercised with zero credential material.
    const codes: number[] = [];
    for (let i = 0; i < ipMax + 1; i++) {
      const r = await server.inject({ method: 'GET', url: '/api/v1/tasks' });
      codes.push(r.statusCode);
    }

    expect(codes.slice(0, ipMax).every((c) => c === 401)).toBe(true);
    expect(codes[ipMax]).toBe(429);
  });
});

/**
 * Issue #75 — proxy-aware keying. With `TRUST_PROXY` set, Fastify resolves
 * `request.ip` from `X-Forwarded-For`, so two clients behind the SAME proxy
 * land in SEPARATE rate-limit buckets (one hitting its limit must not 429
 * the other). With `TRUST_PROXY` OFF (default), a spoofed `X-Forwarded-For`
 * MUST NOT change the bucket — both requests share the socket-IP bucket.
 * These properties are exercised on the IP-keyed layer 1 (`onRequest`,
 * unauthenticated requests) so the trip point is `RATE_LIMIT_MAX *
 * RATE_LIMIT_IP_MAX_FACTOR`, not the raw `RATE_LIMIT_MAX`.
 *
 * These suites build their own server with a distinct env so they don't
 * collide with the module-level RATE_LIMIT_MAX=3 above. resetConfig() drops
 * the cached config so the new env (TRUST_PROXY, low global max) is read.
 */
describe('proxy-aware rate limiting (trustProxy ON)', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let ipMax: number;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    process.env.TRUST_PROXY = 'true';
    resetConfig();
    ipMax = 2 * RATE_LIMIT_IP_MAX_FACTOR;
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
    // the keyGenerator falls through to request.ip (resolved from XFF) on
    // the IP-keyed layer 1 — auth rejects each one (401), but the layer-1
    // counter still increments on every request regardless of that outcome.
    const a = { 'x-forwarded-for': '1.1.1.1' };
    const b = { 'x-forwarded-for': '2.2.2.2' };

    const aCodes: number[] = [];
    for (let i = 0; i < ipMax; i++) {
      const r = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: a });
      aCodes.push(r.statusCode);
    }
    // All of A's first `ipMax` requests reach auth and are rejected (401) —
    // the layer-1 budget is not yet exhausted.
    expect(aCodes.every((c) => c === 401)).toBe(true);
    // A's NEXT request exceeds the budget → 429 for A.
    const aOver = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: a });
    expect(aOver.statusCode).toBe(429);

    // Client B is in a DIFFERENT bucket (different XFF → different resolved
    // IP) — its first request must NOT be 429 even though A is already
    // throttled.
    const b1 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: b });
    expect(b1.statusCode).not.toBe(429);
  });
});

describe('rate limiting with trustProxy OFF (spoof-resistant)', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let ipMax: number;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
    // TRUST_PROXY intentionally UNSET → default false.
    delete process.env.TRUST_PROXY;
    resetConfig();
    ipMax = 2 * RATE_LIMIT_IP_MAX_FACTOR;
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

  it('a spoofed X-Forwarded-For does NOT change the (unauthenticated, IP-keyed) bucket', async () => {
    // Every request claims a DIFFERENT X-Forwarded-For and carries no
    // credential. With trustProxy OFF, request.ip stays the socket IP
    // (127.0.0.1 under inject) for all of them, so they share ONE layer-1
    // bucket and the request beyond `ipMax` is throttled.
    const codes: number[] = [];
    for (let i = 0; i < ipMax; i++) {
      const r = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.every((c) => c === 401)).toBe(true);

    // Spoofing yet another fresh XFF did NOT buy a fresh bucket.
    const over = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { 'x-forwarded-for': '10.0.0.999' },
    });
    expect(over.statusCode).toBe(429);
  });
});

// Separate describe (own server/bucket) from the unauthenticated spoof-
// resistance test above: that test deliberately exhausts the IP-keyed
// layer-1 bucket for 127.0.0.1, which would otherwise bleed into this
// principal-keyed assertion if they shared one server instance.
describe('rate limiting with trustProxy OFF: authenticated bucket is spoof-immune', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';
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

  it('a spoofed X-Forwarded-For does NOT change an AUTHENTICATED bucket', async () => {
    // Every request claims a DIFFERENT X-Forwarded-For but authenticates
    // with the SAME token. The principal-keyed layer 2 ignores IP/XFF
    // entirely once a principal is resolved, so trustProxy is irrelevant
    // here — the requests share ONE `tok:<id>` bucket and the 3rd
    // (> RATE_LIMIT_MAX=2) is throttled, same as the un-spoofed case.
    const auth = seedAuth(db, { displayName: 'spoof-tenant', name: 'spoof-token' });
    const r1 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { ...auth.headers, 'x-forwarded-for': '10.1.0.1' },
    });
    const r2 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { ...auth.headers, 'x-forwarded-for': '10.1.0.2' },
    });
    const r3 = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { ...auth.headers, 'x-forwarded-for': '10.1.0.3' },
    });
    expect(r1.statusCode).not.toBe(429);
    expect(r2.statusCode).not.toBe(429);
    // Spoofing a fresh XFF did NOT buy a fresh bucket for this principal.
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
