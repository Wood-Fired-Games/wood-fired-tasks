import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import { resetConfig } from '../../config/env.js';
import { authHeaders } from './helpers/auth.js';

/**
 * task #185 / task #1612 (H1/H3 audit finding): the Swagger UI / OpenAPI JSON
 * endpoints MUST NOT be exposed to unauthenticated callers, and MUST NOT even
 * be registered (loading the transitive `@fastify/static` — unfixed HIGH
 * advisory — along with `@fastify/swagger-ui`) without an EXPLICIT opt-in.
 *
 * Since #1612, the opt-in (`ENABLE_SWAGGER_IN_PRODUCTION`) is required in
 * EVERY environment, not only production — gating on
 * `config.NODE_ENV !== 'production'` meant an absent NODE_ENV (the common
 * containerized case) silently fell into the permissive branch. The gate now
 * keys off `config.isProductionPosture` (task #1611) for the auth decision:
 *
 * - Opt-in unset (default), ANY environment (including NODE_ENV absent):
 *   /docs and /docs/json return 404 (UI plugin never registered).
 * - Opt-in set + isProductionPosture (explicit 'production', or NODE_ENV
 *   absent/unset): endpoints require Bearer/PAT.
 * - Opt-in set + explicit NODE_ENV=development|test (isProductionPosture
 *   false): endpoints are unauthenticated, as before — dev ergonomics
 *   unchanged, but the opt-in is now mandatory here too.
 *
 * Each test resets the cached config because `createServer` reads the lazy
 * config Proxy at boot — without `resetConfig()` later tests would see the
 * first test's NODE_ENV.
 */
describe('Swagger production gating (task #185)', () => {
  const STRONG_KEY = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6';
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKeys = process.env.API_KEYS;
  const originalEnable = process.env.ENABLE_SWAGGER_IN_PRODUCTION;

  beforeEach(() => {
    resetConfig();
  });

  afterEach(async () => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
    if (originalEnable === undefined) delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;
    else process.env.ENABLE_SWAGGER_IN_PRODUCTION = originalEnable;
    resetConfig();
  });

  it('production + default config: GET /docs returns 404', async () => {
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = STRONG_KEY;
    delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const r = await server.inject({ method: 'GET', url: '/docs' });
      expect(r.statusCode).toBe(404);
    } finally {
      await server?.close();
    }
  });

  it('production + default config: GET /docs/json returns 404', async () => {
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = STRONG_KEY;
    delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const r = await server.inject({ method: 'GET', url: '/docs/json' });
      expect(r.statusCode).toBe(404);
    } finally {
      await server?.close();
    }
  });

  it('production + ENABLE_SWAGGER_IN_PRODUCTION=true: GET /docs without key returns 401', async () => {
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = STRONG_KEY;
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'true';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const r = await server.inject({ method: 'GET', url: '/docs/json' });
      expect(r.statusCode).toBe(401);
      const body = JSON.parse(r.payload);
      expect(body.error).toBe('UNAUTHORIZED');
    } finally {
      await server?.close();
    }
  });

  it('production + ENABLE_SWAGGER_IN_PRODUCTION=true: GET /docs/json with valid key returns the spec', async () => {
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = STRONG_KEY;
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'true';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
      const auth = authHeaders(result.app.db);
      const r = await server.inject({
        method: 'GET',
        url: '/docs/json',
        headers: auth,
      });
      expect(r.statusCode).toBe(200);
      const spec = JSON.parse(r.payload);
      expect(spec.openapi).toBeDefined();
      expect(spec.info.title).toBe('Wood Fired Tasks API');
    } finally {
      await server?.close();
    }
  });

  it('production: ENABLE_SWAGGER_IN_PRODUCTION="false" (or any non-"true" value) keeps the UI off', async () => {
    process.env.NODE_ENV = 'production';
    process.env.API_KEYS = STRONG_KEY;
    // Any non-"true" string must NOT enable the UI — only the exact literal
    // "true" flips the flag. This protects against accidental opt-in from a
    // misconfigured deployment that sets the var to e.g. "1" or "yes".
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'yes';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const r = await server.inject({ method: 'GET', url: '/docs/json' });
      expect(r.statusCode).toBe(404);
    } finally {
      await server?.close();
    }
  });

  it('non-production (test mode) + explicit opt-in: GET /docs/json is reachable without auth (no regression)', async () => {
    // task #1612: the opt-in is now mandatory in EVERY environment — this
    // test's setup was updated to set it explicitly (was previously implicit
    // via the removed `NODE_ENV !== 'production'` auto-expose branch). The
    // ASSERTION (no-auth-required in explicit test/dev) is unchanged.
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = 'test-key';
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'true';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      // Mirrors the assertion in openapi.test.ts
      const r = await server.inject({ method: 'GET', url: '/docs/json' });
      expect(r.statusCode).toBe(200);
    } finally {
      await server?.close();
    }
  });

  it('non-production (test mode), opt-in UNSET: GET /docs/json returns 404 (mandatory opt-in, no auto-expose)', async () => {
    // Guards against regressing back to the pre-#1612 auto-expose behavior:
    // even in explicit non-production, the UI must NOT be registered unless
    // the opt-in is explicitly set.
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = 'test-key';
    delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const r = await server.inject({ method: 'GET', url: '/docs/json' });
      expect(r.statusCode).toBe(404);
    } finally {
      await server?.close();
    }
  });

  it('NODE_ENV deleted (absent), opt-in unset: GET /docs returns 404', async () => {
    // task #1612: an absent NODE_ENV must read as hardened (isProductionPosture
    // === true, per task #1611), not permissive. Without the opt-in, the UI
    // plugin (and its transitive @fastify/static) must never be registered.
    delete process.env.NODE_ENV;
    process.env.API_KEYS = STRONG_KEY;
    delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const r = await server.inject({ method: 'GET', url: '/docs' });
      expect(r.statusCode).toBe(404);
    } finally {
      await server?.close();
    }
  });

  it('NODE_ENV deleted (absent), opt-in set: GET /docs returns 401 without a credential and 200 with a valid one', async () => {
    delete process.env.NODE_ENV;
    process.env.API_KEYS = STRONG_KEY;
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'true';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;

      const unauthed = await server.inject({ method: 'GET', url: '/docs' });
      expect(unauthed.statusCode).toBe(401);

      const auth = authHeaders(result.app.db);
      const authed = await server.inject({ method: 'GET', url: '/docs', headers: auth });
      expect(authed.statusCode).toBe(200);
    } finally {
      await server?.close();
    }
  });

  it('NODE_ENV deleted (absent), opt-in unset: printPlugins() contains neither @fastify/static nor @fastify/swagger-ui', async () => {
    // The vulnerable plugin must not even be LOADED, not just unreachable —
    // @fastify/swagger-ui transitively registers @fastify/static (unfixed
    // HIGH advisory).
    delete process.env.NODE_ENV;
    process.env.API_KEYS = STRONG_KEY;
    delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const printed = await server.printPlugins();
      expect(printed).not.toContain('@fastify/static');
      expect(printed).not.toContain('@fastify/swagger-ui');
    } finally {
      await server?.close();
    }
  });

  it('positive control — NODE_ENV=development + opt-in set: printPlugins() contains BOTH @fastify/static AND @fastify/swagger-ui', async () => {
    process.env.NODE_ENV = 'development';
    process.env.API_KEYS = STRONG_KEY;
    process.env.ENABLE_SWAGGER_IN_PRODUCTION = 'true';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;
      const printed = await server.printPlugins();
      expect(printed).toContain('@fastify/static');
      expect(printed).toContain('@fastify/swagger-ui');
    } finally {
      await server?.close();
    }
  });
});
