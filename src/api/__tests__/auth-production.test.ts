import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';

/**
 * Production-mode API_KEYS validation (task #182).
 *
 * `createServer` must refuse startup when NODE_ENV=production AND API_KEYS
 * fails the hardening rules. Valid strong keys must continue to work.
 */
describe('API_KEYS production validation', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    // Restore both vars to their pre-test values so other suites are not affected.
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = originalApiKeys;
  });

  it('refuses startup when API_KEYS is empty', async () => {
    // Empty API_KEYS triggers the Zod config schema's .min(1) first, which
    // calls process.exit(78) outside the test environment. Vitest converts
    // that into a thrown error we can assert on. Either way, the server must
    // refuse to come up — this test only verifies that empty API_KEYS does
    // NOT result in a running server.
    process.env.API_KEYS = '';
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow();
  });

  it('refuses startup when API_KEYS is the change-me placeholder', async () => {
    process.env.API_KEYS = 'change-me-to-a-real-key';
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow(
      /API_KEYS validation failed/i,
    );
  });

  it('refuses startup when API_KEYS is too short', async () => {
    process.env.API_KEYS = 'short-key';
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow(/at least 32 characters/i);
  });

  it('refuses startup when API_KEYS is a single repeated character (no entropy)', async () => {
    process.env.API_KEYS = 'a'.repeat(64);
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow(
      /single character repeated/i,
    );
  });

  it('refuses startup when API_KEYS contains a placeholder phrase', async () => {
    process.env.API_KEYS = 'example-' + 'x'.repeat(30);
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow(
      /placeholder phrase "example"/,
    );
  });

  it('refuses startup when ANY of multiple comma-separated keys fails validation', async () => {
    // First key strong, second key weak.
    process.env.API_KEYS = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6,short';
    await expect(createServer({ dbPath: ':memory:' })).rejects.toThrow(
      /API_KEYS validation failed/i,
    );
  });

  it('starts successfully with a strong 32-character key and accepts valid auth', async () => {
    const strongKey = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6';
    process.env.API_KEYS = strongKey;

    let server: FastifyInstance | undefined;
    try {
      const result = await createServer({ dbPath: ':memory:' });
      server = result.server;

      const ok = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': strongKey },
      });
      expect(ok.statusCode).toBe(200);

      const bad = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': 'definitely-not-the-right-key-xxxxxxxxxxxxxx' },
      });
      expect(bad.statusCode).toBe(401);
    } finally {
      await server?.close();
    }
  });
});
