import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';

// Set API keys to ensure auth is configured but health endpoint bypasses it
process.env.API_KEYS = 'test-key';

describe('Health Check', () => {
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
    expect(body.checks).toMatchObject({
      database: 'ok',
    });
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
    expect(body.version).toBe('1.0.0');
  });

  describe('Component Status Checks', () => {
    it('should include database check in response', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.checks).toBeDefined();
      expect(body.checks.database).toBeDefined();
      expect(['ok', 'failed']).toContain(body.checks.database);
    });

    it('should include eventBus check in response', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.checks).toBeDefined();
      expect(body.checks.eventBus).toBeDefined();
      expect(['ok', 'degraded', 'unknown']).toContain(body.checks.eventBus);
    });

    it('should include sseManager check in response', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.checks).toBeDefined();
      expect(body.checks.sseManager).toBeDefined();
      expect(['ok', 'degraded', 'unknown']).toContain(body.checks.sseManager);
    });

    it('should include stats in response when available', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.stats).toBeDefined();
      expect(body.stats.eventBus).toBeDefined();
      expect(body.stats.sseManager).toBeDefined();
    });

    it('should have eventBus.stats with listenerCount', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.stats.eventBus.listenerCount).toBeDefined();
      expect(typeof body.stats.eventBus.listenerCount).toBe('number');
      expect(body.stats.eventBus.listenerCount).toBeGreaterThanOrEqual(0);
    });

    it('should have sseManager.stats with clientCount', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.stats.sseManager.clientCount).toBeDefined();
      expect(typeof body.stats.sseManager.clientCount).toBe('number');
      expect(body.stats.sseManager.clientCount).toBeGreaterThanOrEqual(0);
    });

    it('should have sseManager.stats with uptime', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.stats.sseManager.uptime).toBeDefined();
      expect(typeof body.stats.sseManager.uptime).toBe('number');
      expect(body.stats.sseManager.uptime).toBeGreaterThanOrEqual(0);
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

    it('should have database check as ok when healthy', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/health',
      });

      const body = JSON.parse(response.payload);
      expect(body.checks.database).toBe('ok');
    });
  });
});
