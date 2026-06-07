import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import { authHeaders } from './helpers/auth.js';

/**
 * Production-mode boot behaviour around API_KEYS (v2.0 release-blocker H2).
 *
 * The legacy X-API-Key REST strategy was removed in the v2.0 auth cutover
 * (#799/#802); REST now authenticates via PAT → session only. The old
 * production fatal gate (`validateApiKeysForProduction`, which threw on an
 * empty/weak/placeholder API_KEYS and aborted boot) therefore guarded a
 * non-functional feature and broke upgraders who correctly dropped API_KEYS.
 * That gate has been removed.
 *
 * These tests pin the new contract: a production server boots WITHOUT
 * API_KEYS and authenticates via a seeded Bearer PAT.
 */
describe('production boot without API_KEYS (H2)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    // The whole point of H2: API_KEYS is unset in a correct 2.0 deployment.
    delete process.env.API_KEYS;
  });

  afterEach(() => {
    // Restore both vars to their pre-test values so other suites are not affected.
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
  });

  it('boots successfully with API_KEYS unset and authenticates via a Bearer PAT', async () => {
    let server: FastifyInstance | undefined;
    try {
      // No API_KEYS in the environment — the removed fatal gate would have
      // aborted this boot in production. It must now succeed.
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;

      // A seeded Bearer PAT authenticates; the API_KEYS value is irrelevant.
      const auth = authHeaders(result.app.db);
      const ok = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: auth,
      });
      expect(ok.statusCode).toBe(200);

      // A bogus PAT is still rejected — auth is enforced, it's just no longer
      // gated on a static API_KEYS list.
      const bad = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { Authorization: 'Bearer definitely-not-a-real-pat-xxxxxxxxxxxx' },
      });
      expect(bad.statusCode).toBe(401);
    } finally {
      await server?.close();
    }
  });

  it('boots successfully in production even when API_KEYS is set to a weak/placeholder value', async () => {
    // Pre-2.0 this would have thrown (placeholder phrase, too short, etc.).
    // API_KEYS no longer gates REST boot at all, so a leftover value — however
    // weak — must not abort startup.
    process.env.API_KEYS = 'change-me-to-a-real-key';

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;

      const auth = authHeaders(result.app.db);
      const ok = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: auth,
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await server?.close();
    }
  });
});
