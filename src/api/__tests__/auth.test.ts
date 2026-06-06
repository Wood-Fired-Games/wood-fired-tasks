import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { authHeaders } from './helpers/auth.js';

describe('API Authentication', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let auth: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    auth = authHeaders(db);
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

  it('should accept requests with a valid Bearer PAT', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: auth,
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

  // v2.0 (#799/#802): the legacy X-API-Key strategy and its `is_legacy`
  // principal seeding were removed. The chain plugin now resolves
  // `request.user` from a Bearer PAT instead. Smoke-check that the PAT seeded
  // by `authHeaders` has a backing `users` row the chain plugin can resolve
  // via the api_tokens -> users join.
  it('seeds a PAT principal so the chain plugin can resolve request.user', async () => {
    const userRow = db
      .prepare(
        `SELECT u.id AS id
           FROM api_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.revoked_at IS NULL
          ORDER BY t.id DESC
          LIMIT 1`,
      )
      .get() as { id: number } | undefined;
    expect(userRow).toBeDefined();
    expect(typeof userRow!.id).toBe('number');
  });
});
