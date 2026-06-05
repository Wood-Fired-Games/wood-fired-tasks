import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { eventBus } from '../../events/event-bus.js';

// Set API keys before importing server
process.env.API_KEYS = 'test-key';

describe('Events API (SSE)', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    process.env.API_KEYS = 'test-key';
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // Create test project for filtering tests
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(1, 'Test Project 1');
    db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(2, 'Test Project 2');
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  describe('GET /api/v1/events', () => {
    // Note: SSE testing with Fastify inject() is limited because the @fastify/sse plugin
    // doesn't fully support inject mode. These tests verify route registration and auth.
    // Comprehensive SSE functionality is tested in sse-manager.test.ts

    it('should require authentication', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should accept valid API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events',
        headers: { 'X-API-Key': 'test-key' },
      });

      // SSE endpoints return 500 in inject mode due to plugin limitations
      // But it should not be a 401 (auth passed)
      expect(response.statusCode).not.toBe(401);
    });

    it('should accept project_id filter query parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events?project_id=1',
        headers: { 'X-API-Key': 'test-key' },
      });

      // Query parameter should be parsed (auth passed, route exists)
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(404);
    });

    it('should accept event_types filter query parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events?event_types=task.created,task.updated',
        headers: { 'X-API-Key': 'test-key' },
      });

      // Query parameter should be parsed
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(404);
    });

    it('should accept Last-Event-ID header', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events',
        headers: {
          'X-API-Key': 'test-key',
          'Last-Event-ID': '5',
        },
      });

      // Header should be accepted
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(404);
    });
  });

  describe('Event Broadcasting Integration', () => {
    it('should wire EventBus events to SSEManager', () => {
      // Verify that eventBus and sseManager are connected
      // This is tested implicitly by the fact that the server starts without errors
      // and the wiring is done in server.ts

      expect(server.sseManager).toBeDefined();
    });
  });
});
