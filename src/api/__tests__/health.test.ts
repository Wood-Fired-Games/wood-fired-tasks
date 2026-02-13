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
});
