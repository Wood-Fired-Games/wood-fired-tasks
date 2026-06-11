import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { eventBus } from '../../events/event-bus.js';
import { ClaimReleaseService } from '../../services/claim-release.service.js';
import { authHeaders } from './helpers/auth.js';

describe('Events API (SSE)', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let auth: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    auth = authHeaders(db);

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
        headers: auth,
      });

      // SSE endpoints return 500 in inject mode due to plugin limitations
      // But it should not be a 401 (auth passed)
      expect(response.statusCode).not.toBe(401);
    });

    it('should accept project_id filter query parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events?project_id=1',
        headers: auth,
      });

      // Query parameter should be parsed (auth passed, route exists)
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(404);
    });

    it('should accept event_types filter query parameter', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/events?event_types=task.created,task.updated',
        headers: auth,
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
          ...auth,
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

    it('relays task.claim_released from the TTL sweep to SSEManager.broadcast (task #1003)', () => {
      // End-to-end: stale claim → ClaimReleaseService.sweep() → eventBus →
      // the server.ts subscription → SSEManager.broadcast. Same relay path
      // as task.status_changed, so the event is SSE-visible at
      // GET /api/v1/events and filterable via event_types.
      db.prepare(
        `INSERT INTO tasks (
          title, status, priority, project_id, assignee, created_by,
          claimed_at, created_at, updated_at, version
        ) VALUES (
          'Stale SSE Task', 'in_progress', 'medium', 1, 'agent-sse', 'creator',
          datetime('now', '-31 minutes'), datetime('now', '-60 minutes'),
          datetime('now', '-31 minutes'), 2
        )`,
      ).run();

      const broadcastSpy = vi.spyOn(server.sseManager, 'broadcast');
      const sweepService = new ClaimReleaseService(db, 30);
      const released = sweepService.sweep();

      expect(released).toBe(1);
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'task.claim_released',
          metadata: expect.objectContaining({ source: 'workflow' }),
          data: expect.objectContaining({
            previous_assignee: 'agent-sse',
            expired_claimed_at: expect.any(String),
            released_at: expect.any(String),
            status: 'open',
            assignee: null,
          }),
        }),
      );

      broadcastSpy.mockRestore();
    });
  });
});
