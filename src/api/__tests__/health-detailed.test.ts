import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';
import { VERSION } from '../../utils/version.js';
import { authHeaders } from './helpers/auth.js';

/**
 * task #185: /health/detailed exposes the full diagnostic payload (component
 * checks + runtime stats) and is gated by the canonical auth plugin — the
 * SAME Bearer/PAT requirement as /api/v1.
 *
 * The public /health route is covered by `health.test.ts` and asserts the
 * minimal shape (no checks/stats). This file covers ONLY the detailed
 * authenticated route.
 */

describe('Authenticated /health/detailed', () => {
  let server: FastifyInstance;
  let app: App;
  let auth: { Authorization: string };

  beforeEach(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    auth = authHeaders(app.db);
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
  });

  it('returns 401 without X-API-Key header', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/detailed',
    });
    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('UNAUTHORIZED');
  });

  it('returns 401 with an invalid X-API-Key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/detailed',
      headers: { 'x-api-key': 'wrong-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 200 with full diagnostic payload when authenticated', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/detailed',
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    // Same shape as the pre-task-#185 /health route
    expect(body.status).toBe('healthy');
    expect(body.timestamp).toBeDefined();
    expect(body.version).toBe(VERSION);

    // Component checks
    expect(body.checks).toBeDefined();
    expect(body.checks.database).toBe('ok');
    expect(['ok', 'degraded', 'unknown']).toContain(body.checks.eventBus);
    expect(['ok', 'degraded', 'unknown']).toContain(body.checks.sseManager);

    // Runtime stats (the formerly-public surface that task #185 hides)
    expect(body.stats).toBeDefined();
    expect(typeof body.stats.eventBus.listenerCount).toBe('number');
    expect(typeof body.stats.sseManager.clientCount).toBe('number');
    expect(typeof body.stats.sseManager.uptime).toBe('number');

    // DB fingerprint (task #354): which DB this process opened + cheap counts,
    // so a wrong/stale DB is obvious. Authenticated-only — never on public /health.
    expect(body.database).toBeDefined();
    expect(typeof body.database.path).toBe('string');
    expect(body.database.path.length).toBeGreaterThan(0);
    expect(typeof body.database.projects).toBe('number');
    expect(body.database).toHaveProperty('maxTaskId');
    expect(body.database).toHaveProperty('latestActivity');
  });

  it('responds with application/json content-type', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health/detailed',
      headers: auth,
    });
    expect(response.headers['content-type']).toContain('application/json');
  });
});
