import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';

// Set API keys to ensure auth is configured. Note that /health bypasses
// auth — these tests confirm task #185's minimal default response shape.
process.env.API_KEYS = 'test-key';

describe('Public /health (minimal)', () => {
  let server: FastifyInstance;
  let app: App;

  beforeEach(async () => {
    // Create server with in-memory database
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
  });

  it('GET /health returns 200 with healthy status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      // Note: No X-API-Key header provided
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload);
    expect(body.status).toBe('healthy');
  });

  it('GET /health returns Content-Type: application/json', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['content-type']).toContain('application/json');
  });

  it('GET /health does NOT require X-API-Key header (no 401)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
      // No auth header
    });

    // Should NOT be 401 - health check is public
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).toBe(200);
  });

  it('Response includes timestamp in ISO format', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    const body = JSON.parse(response.payload);
    expect(body.timestamp).toBeDefined();
    expect(typeof body.timestamp).toBe('string');

    // Verify it's a valid ISO date
    const date = new Date(body.timestamp);
    expect(date.toISOString()).toBe(body.timestamp);
  });

  it('Response includes version field', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    const body = JSON.parse(response.payload);
    expect(body.version).toBeDefined();
    expect(typeof body.version).toBe('string');
    expect(body.version).toBe('1.11.0');
  });

  /**
   * task #185: the public /health endpoint MUST NOT leak internal stats —
   * SSE client count, uptime, listener counts, per-component status. Those
   * now live on the authenticated /health/detailed route.
   */
  describe('Minimal response shape (task #185)', () => {
    it('GET /health response has exactly status + timestamp + version (no checks/stats)', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(Object.keys(body).sort()).toEqual(['status', 'timestamp', 'version']);
    });

    it('GET /health response does NOT include a `checks` field', async () => {
      const response = await server.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(response.payload);
      expect(body.checks).toBeUndefined();
    });

    it('GET /health response does NOT include a `stats` field', async () => {
      const response = await server.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(response.payload);
      expect(body.stats).toBeUndefined();
    });

    it('GET /health response does NOT leak SSE client count', async () => {
      const response = await server.inject({ method: 'GET', url: '/health' });
      const body = JSON.parse(response.payload);
      // No nested object should contain clientCount or uptime keys
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/clientCount/);
      expect(serialized).not.toMatch(/uptime/);
      expect(serialized).not.toMatch(/listenerCount/);
    });
  });

  describe('Health Status Scenarios', () => {
    it('should return status healthy when database is ok', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('healthy');
    });
  });
});
