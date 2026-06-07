import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import { resetConfig } from '../../config/env.js';
import { authHeaders } from './helpers/auth.js';

/**
 * task #185: in NODE_ENV=production, the Swagger UI / OpenAPI JSON endpoints
 * MUST NOT be exposed to unauthenticated callers.
 *
 * - Default production config → /docs and /docs/json return 404 (not registered).
 * - Production + ENABLE_SWAGGER_IN_PRODUCTION=true → endpoints require Bearer/PAT.
 * - Non-production (development, test) → endpoints are unauthenticated, as before.
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

  it('non-production (test mode): GET /docs/json is reachable without auth (no regression)', async () => {
    process.env.NODE_ENV = 'test';
    process.env.API_KEYS = 'test-key';
    delete process.env.ENABLE_SWAGGER_IN_PRODUCTION;

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
});
