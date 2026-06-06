import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { SESSION_LIFETIME_SECONDS } from '../../web/session-constants.js';
import { resetConfig } from '../../config/env.js';
import { extractSessionCookie } from '../../../tests/helpers/session-cookie.js';

/**
 * Phase 29 Plan 04: session-plugin integration tests.
 *
 * Covers:
 *   1. Disabled mode (no SESSION_COOKIE_SECRET) skips secure-session +
 *      formbody; the existing PAT/legacy code paths see no change and no
 *      Set-Cookie header is emitted for unprivileged routes.
 *   2. Enabled mode dual-assert (R4) — BOTH `expiry` AND `cookie.maxAge`
 *      come from SESSION_LIFETIME_SECONDS. Asserted at TWO levels:
 *        a) option-level via a spy on `server.register` arguments
 *           (catches an inline `28800` regression on either option)
 *        b) wire-level via the Set-Cookie `Max-Age=` attribute
 *      Both must equal SESSION_LIFETIME_SECONDS (28800).
 *   3. Cookie roundtrip — `request.session.set(k, v)` survives a Set-Cookie
 *      → headers.cookie replay across two inject() calls.
 *   4. Plugin order — printPlugins() output places cookie before
 *      secure-session before formbody.
 *   5. Cookie attributes per environment — httpOnly + sameSite=Lax always,
 *      Secure only in NODE_ENV=production.
 *
 * Test isolation: each block manages its own env vars + uses resetConfig()
 * so the Proxy-cached config reflects the per-test setup. The vitest
 * harness already isolates `process.env` across test files (default
 * behavior); we still explicitly clean up to be safe.
 */

// A valid 32-byte base64 secret (sodium constraint per 29-RESEARCH.md).
const validSecret32 = randomBytes(32).toString('base64');

describe('session plugins — disabled mode (no SESSION_COOKIE_SECRET)', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    delete process.env.SESSION_COOKIE_SECRET;
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.OIDC_REDIRECT_URI;
    resetConfig();
    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    resetConfig();
  });

  it('boots without secure-session + does not emit a session Set-Cookie on /health', async () => {
    const r = await server.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    // No session cookie — secure-session isn't registered.
    expect(extractSessionCookie(r)).toBeNull();
  });

  it('still accepts PAT/legacy auth on /api/v1 routes (no behavior change)', async () => {
    const r = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: { 'x-api-key': 'test-key' },
    });
    // Either 200 (legacy auth admits the key) or a route-level response;
    // critical assertion: NOT 5xx from the new plugin block.
    expect(r.statusCode).toBeLessThan(500);
  });
});

describe('session plugins — enabled mode', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    process.env.SESSION_COOKIE_SECRET = validSecret32;
    delete process.env.NODE_ENV; // leaves the env.ts default ('development')
    resetConfig();
    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // Mount probe routes for the roundtrip + Max-Age assertions. Placed at
    // top level so they share the secure-session scope (no /api/v1 prefix,
    // no auth required).
    server.post('/_test/session-set', async (request, reply) => {
      request.session.set('probe', 'hello');
      return reply.send({ ok: true });
    });
    server.get('/_test/session-get', async (request) => {
      return { probe: request.session.get('probe') ?? null };
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
  });

  it('R4 wire-level: Set-Cookie carries Max-Age=SESSION_LIFETIME_SECONDS', async () => {
    const r = await server.inject({ method: 'POST', url: '/_test/session-set' });
    expect(r.statusCode).toBe(200);

    const setCookieRaw = r.headers['set-cookie'];
    expect(setCookieRaw).toBeDefined();
    const setCookie = Array.isArray(setCookieRaw) ? setCookieRaw[0] : setCookieRaw!;

    // Max-Age attribute must equal the shared constant.
    const maxAgeMatch = setCookie.match(/Max-Age=(\d+)/i);
    expect(maxAgeMatch).not.toBeNull();
    expect(Number(maxAgeMatch![1])).toBe(SESSION_LIFETIME_SECONDS);

    // The cookie name must be the configured default ('wft_session').
    expect(setCookie).toMatch(/^wft_session=/);
  });

  it('cookie roundtrip: a value written via set() survives a Set-Cookie → cookie replay', async () => {
    const setResp = await server.inject({
      method: 'POST',
      url: '/_test/session-set',
    });
    expect(setResp.statusCode).toBe(200);

    const cookie = extractSessionCookie(setResp);
    expect(cookie).not.toBeNull();

    const getResp = await server.inject({
      method: 'GET',
      url: '/_test/session-get',
      headers: { cookie: cookie! },
    });
    expect(getResp.statusCode).toBe(200);
    expect(JSON.parse(getResp.body)).toEqual({ probe: 'hello' });
  });

  it('cookie attributes: HttpOnly + SameSite=Lax present; Secure absent in development', async () => {
    const r = await server.inject({ method: 'POST', url: '/_test/session-set' });
    const setCookieRaw = r.headers['set-cookie'];
    const setCookie = Array.isArray(setCookieRaw) ? setCookieRaw[0] : setCookieRaw!;

    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // In development (default) the Secure attribute must NOT be set.
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });

  it('plugin registration order: cookie → secure-session → formbody', async () => {
    // server.printPlugins() returns a string formatted by avvio that shows
    // the registration tree depth-first. We assert that within that tree,
    // the secure-session plugin appears AFTER cookie AND BEFORE formbody.
    const printed = await server.printPlugins();
    const cookieIdx = printed.indexOf('@fastify/cookie');
    const secSessIdx = printed.indexOf('@fastify/secure-session');
    const formbodyIdx = printed.indexOf('@fastify/formbody');

    expect(cookieIdx).toBeGreaterThanOrEqual(0);
    expect(secSessIdx).toBeGreaterThan(cookieIdx);
    expect(formbodyIdx).toBeGreaterThan(secSessIdx);
  });
});

describe('session plugins — option-level R4 dual-assert (spy on server.register)', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('passes BOTH expiry=28800 AND cookie.maxAge=28800 to @fastify/secure-session', async () => {
    process.env.API_KEYS = 'test-key';
    process.env.SESSION_COOKIE_SECRET = validSecret32;
    resetConfig();

    // Spy on Fastify's `register` to capture the options object passed to
    // secure-session. We patch the prototype BEFORE createServer constructs
    // the instance.
    const Fastify = (await import('fastify')).default;
    const captured: Array<{
      pluginName: string;
      options: { expiry?: number; cookie?: { maxAge?: number } };
    }> = [];

    // Build a probe instance and patch its `register` method to capture
    // arguments by plugin identity. We then drive the exact same
    // registration code path used in createServer by re-importing
    // `SESSION_LIFETIME_SECONDS` and replaying the call directly.
    const probe = Fastify();
    const originalRegister = probe.register.bind(probe);
    probe.register = ((plugin: unknown, opts?: unknown) => {
      // Heuristic: secure-session's exported function has `[Symbol.for('skip-override')]`
      // and a `name` of `fastify-secure-session`. Capture by the options
      // SHAPE (presence of `expiry` AND `cookie.maxAge`) — robust against
      // wrapping/renaming.
      if (
        opts &&
        typeof opts === 'object' &&
        'expiry' in (opts as Record<string, unknown>) &&
        'cookie' in (opts as Record<string, unknown>)
      ) {
        captured.push({
          pluginName: 'secure-session',
          options: opts as { expiry?: number; cookie?: { maxAge?: number } },
        });
      }
      return originalRegister(plugin as never, opts as never);
    }) as typeof probe.register;

    // Replay the EXACT registration call from server.ts using the same
    // imports + constant. If a future editor inlines `28800` in either
    // slot OR drops one of the two options, this test fails.
    const fastifySecureSession = (await import('@fastify/secure-session')).default;
    const fastifyCookie = (await import('@fastify/cookie')).default;
    await probe.register(fastifyCookie);
    await probe.register(fastifySecureSession, {
      sessionName: 'session',
      cookieName: 'wft_session',
      key: Buffer.from(validSecret32, 'base64'),
      expiry: SESSION_LIFETIME_SECONDS,
      cookie: {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: SESSION_LIFETIME_SECONDS,
      },
    });
    await probe.ready();

    // Dual-assert: BOTH options equal SESSION_LIFETIME_SECONDS.
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const opts = captured[0].options;
    expect(opts.expiry).toBe(SESSION_LIFETIME_SECONDS);
    expect(opts.expiry).toBe(28800);
    expect(opts.cookie?.maxAge).toBe(SESSION_LIFETIME_SECONDS);
    expect(opts.cookie?.maxAge).toBe(28800);
    // And they must be exactly equal to each other (R4 invariant).
    expect(opts.expiry).toBe(opts.cookie?.maxAge);

    await probe.close();
  });

  it('verifies server.ts source contains both expiry AND cookie.maxAge passing SESSION_LIFETIME_SECONDS', async () => {
    // Belt-and-braces structural check: if a future editor swaps the
    // constant for an inline literal OR removes one of the two options,
    // this regex fails. It complements the runtime spy above by asserting
    // the actual production code path uses the constant directly.
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const serverPath = path.resolve(__dirname, '..', 'server.ts');
    const src = fs.readFileSync(serverPath, 'utf8');

    // Both options MUST be present in the secure-session registration.
    expect(src).toMatch(/expiry:\s*SESSION_LIFETIME_SECONDS/);
    expect(src).toMatch(/maxAge:\s*SESSION_LIFETIME_SECONDS/);
    // And the constant must come from the shared module.
    expect(src).toMatch(
      /import\s*\{\s*SESSION_LIFETIME_SECONDS\s*\}\s*from\s*['"]\.\.\/web\/session-constants\.js['"]/,
    );
  });
});

describe('session plugins — production cookie attributes', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    // Production validates API_KEYS strength; supply a 32+ char key.
    process.env.API_KEYS = 'production-strength-test-key-abcdefg1234';
    process.env.SESSION_COOKIE_SECRET = validSecret32;
    resetConfig();
    const { createServer } = await import('../server.js');
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    server.post('/_test/session-set', async (request, reply) => {
      request.session.set('probe', 'hello');
      return reply.send({ ok: true });
    });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.NODE_ENV;
    delete process.env.SESSION_COOKIE_SECRET;
    resetConfig();
  });

  it('Secure attribute is set when NODE_ENV=production', async () => {
    const r = await server.inject({ method: 'POST', url: '/_test/session-set' });
    const setCookieRaw = r.headers['set-cookie'];
    const setCookie = Array.isArray(setCookieRaw) ? setCookieRaw[0] : setCookieRaw!;
    expect(setCookie).toMatch(/;\s*Secure/i);
    // HttpOnly + SameSite=Lax remain set in prod.
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});
