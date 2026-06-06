import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';

// Set API keys before importing server
process.env.API_KEYS = 'test-key';

describe('API Authentication', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    // Ensure API keys are set before server creation
    process.env.API_KEYS = 'test-key';
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('should reject requests without X-API-Key header with 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    const body = JSON.parse(response.body);
    // Phase 28 (Plan 04): uniform 401 body — distinct reasonCode lives in
    // the audit log only (Threat T-28-04-02). The legacy
    // "Missing API key. Provide X-API-Key header." message was replaced by
    // the chain plugin's `{ error: 'UNAUTHORIZED', message: 'Authentication
    // required' }` so callers cannot probe which strategy failed via the
    // response body.
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.message).toBe('Authentication required');
  });

  it('should reject requests with invalid X-API-Key with 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-api-key': 'invalid-key',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    const body = JSON.parse(response.body);
    // Phase 28 (Plan 04): same uniform 401 body — the distinct reasonCode
    // 'unknown_token' is in the audit log, not the response.
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.message).toBe('Authentication required');
  });

  it('should accept requests with valid test-key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-api-key': 'test-key',
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('should reject POST requests without API key with 401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        title: 'Test Task',
        project_id: 1,
        created_by: 'test',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
  });

  // Phase 28 (Plan 04) — additive assertion: the chain plugin's legacy
  // strategy depends on a seeded `users` row with `is_legacy=1` and
  // `display_name='key_test-key'` (auto-derived from the bare 'test-key'
  // API_KEYS entry by `config/env.ts:213`). Smoke-check that
  // `seedIdentities()` ran during `createApp` and produced the row the
  // legacy strategy will look up via `findLegacyByDisplayName`.
  it('seeds the legacy principal so the chain plugin can resolve request.user', async () => {
    const userRow = db
      .prepare('SELECT id FROM users WHERE display_name = ? AND is_legacy = 1')
      .get('key_test-key') as { id: number } | undefined;
    expect(userRow).toBeDefined();
    expect(typeof userRow!.id).toBe('number');
  });
});
