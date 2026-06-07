import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';
import { authHeaders } from './helpers/auth.js';

/**
 * GET /api/v1/tasks/completion-report
 *
 * task #245 — parity fix between local and remote MCP `completion_report`
 * tool. The REST surface here is the only path the remote MCP server uses,
 * so we validate:
 *   1. The static `/completion-report` path beats the `/:id` dynamic route
 *      (would otherwise 400 with "Invalid id" from Zod coercion).
 *   2. Output envelope matches `TaskService.getCompletionReport` exactly.
 *   3. Validation rules from CompletionReportSchema are enforced server-side
 *      (`days` xor `start`+`end`, range ordering, 1-365 bound).
 *   4. Filters (`project_id`, `assignee`) narrow results.
 *   5. Auth gate is honored (no key → 401, like every other /api/v1 path).
 */
describe('GET /api/v1/tasks/completion-report', () => {
  let server: FastifyInstance;
  let app: App;
  let headers: { Authorization: string };
  let projectAId: number;
  let projectBId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    await server.ready();

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    headers = authHeaders(app.db);

    projectAId = app.projectService.createProject({ name: 'Alpha' }).id;
    projectBId = app.projectService.createProject({ name: 'Beta' }).id;
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
  });

  /**
   * Create a task and walk it through statuses ending at 'done'. Mirrors the
   * helper in services/__tests__/completion-report.test.ts so the REST tests
   * exercise the same fixture pattern as the service-layer tests.
   */
  function completeTask(
    projectId: number,
    title: string,
    opts: { assignee?: string; priority?: 'low' | 'medium' | 'high' | 'urgent' } = {},
  ): { id: number } {
    const task = app.taskService.createTask({
      title,
      project_id: projectId,
      created_by: 'tester',
      priority: opts.priority ?? 'medium',
    });
    app.taskService.updateTask(task.id, {
      status: 'in_progress',
      assignee: opts.assignee ?? null,
    });
    const done = app.taskService.updateTask(task.id, { status: 'done' });
    return { id: done.id };
  }

  it('returns 200 with full envelope for trailing window', async () => {
    completeTask(projectAId, 'a1', { assignee: 'alice', priority: 'high' });
    completeTask(projectAId, 'a2', { assignee: 'bob', priority: 'high' });
    completeTask(projectBId, 'b1', { assignee: 'alice', priority: 'low' });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/completion-report?days=30',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Envelope shape — every field must be present
    expect(body).toHaveProperty('range.start');
    expect(body).toHaveProperty('range.end');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('by_project');
    expect(body).toHaveProperty('by_assignee');
    expect(body).toHaveProperty('by_priority');
    expect(body).toHaveProperty('daily_throughput');

    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(3);
    expect(body.by_project).toContainEqual({ project_id: projectAId, count: 2 });
    expect(body.by_project).toContainEqual({ project_id: projectBId, count: 1 });
    expect(body.by_assignee).toContainEqual({ assignee: 'alice', count: 2 });
    expect(body.by_priority).toContainEqual({ priority: 'high', count: 2 });
  });

  it('honors project_id filter via query string', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/completion-report?days=30&project_id=${projectAId}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBeGreaterThan(0);
    expect(body.rows.every((r: { project_id: number }) => r.project_id === projectAId)).toBe(true);
  });

  it('honors assignee filter via query string', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/completion-report?days=30&assignee=alice',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBeGreaterThan(0);
    expect(body.rows.every((r: { assignee: string | null }) => r.assignee === 'alice')).toBe(true);
  });

  it('accepts explicit start/end bounds', async () => {
    const response = await server.inject({
      method: 'GET',
      url:
        '/api/v1/tasks/completion-report' +
        '?start=2020-01-01T00:00:00Z' +
        '&end=2020-12-31T23:59:59Z',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Window entirely in the past, fixtures live in "now" — empty result
    expect(body.total).toBe(0);
  });

  it('returns 400 when neither days nor a complete range is supplied', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/completion-report',
      headers,
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when end precedes start', async () => {
    const response = await server.inject({
      method: 'GET',
      url:
        '/api/v1/tasks/completion-report' +
        '?start=2026-02-01T00:00:00Z' +
        '&end=2026-01-01T00:00:00Z',
      headers,
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when days exceeds 365', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/completion-report?days=400',
      headers,
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 401 without API key (auth gate)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/completion-report?days=7',
      // headers intentionally omitted
    });

    expect(response.statusCode).toBe(401);
  });

  it('static /completion-report route beats /:id dynamic matcher', async () => {
    // Regression guard: Fastify must route the static path to the report
    // handler, not the GET /:id handler that would 400 on "completion-report"
    // failing Zod's `z.coerce.number().int().positive()` for params.id.
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/completion-report?days=1',
      headers,
    });

    // 200 (report) — not 400 (id coercion failure)
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('range');
    expect(body).toHaveProperty('total');
  });
});
