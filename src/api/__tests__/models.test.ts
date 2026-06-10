import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { authHeaders } from './helpers/auth.js';

/**
 * Configurable Task Models (Task 13) — GET /api/v1/models.
 *
 * In the test environment ANTHROPIC_API_KEY is absent, so the model-catalog
 * service serves the STATIC fallback with `stale: true`. The route must still
 * return 200 with the `{ models, stale }` envelope.
 */
describe('GET /api/v1/models', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
    headers = authHeaders(db);
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('returns 200 with a { models, stale } body', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/models',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body.models)).toBe(true);
    expect(typeof body.stale).toBe('boolean');
    // Each entry carries the normalised catalog shape.
    for (const m of body.models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.display_name).toBe('string');
      expect(typeof m.family).toBe('string');
      expect(typeof m.created_at).toBe('string');
    }
  });

  it('serves the static fallback (stale: true) when no API key is configured', async () => {
    // The test env has no ANTHROPIC_API_KEY, so the service degrades to the
    // static fallback. This is the documented degrade contract.
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/models',
      headers,
    });
    const body = JSON.parse(response.body);
    expect(body.stale).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/models',
    });
    expect(response.statusCode).toBe(401);
  });
});
