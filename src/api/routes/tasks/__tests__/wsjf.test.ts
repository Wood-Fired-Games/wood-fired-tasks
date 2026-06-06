import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';

/**
 * WSJF 4.5 (task #645) — integration tests for the task WSJF REST surface:
 *   GET  /api/v1/tasks/:id/wsjf
 *   PUT  /api/v1/tasks/:id/wsjf           (set / lock components, manual gate)
 *   GET  /api/v1/tasks/:id/score-history  (chronological)
 *
 * The PUT path MUST mirror the MCP manual gate (`validateManualScore`):
 *   - off-scale Fibonacci tier → 400
 *   - jobSize=1 ∧ value=13 contradiction → 400
 *   - valid components persist + append a `manual` score-history row.
 */

const TEST_KEY = 'test-key-task-wsjf';
const TEST_LABEL = 'task-wsjf-route';

describe('task WSJF REST surface', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;
  let taskId: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    const project = app.projectService.createProject({ name: 'WSJF Tasks' });
    projectId = project.id;
    taskId = app.taskService.createTask({
      title: 'score me',
      project_id: projectId,
      priority: 'medium',
      created_by: 'seed',
    }).id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (prevApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = prevApiKeys;
  });

  it('GET /:id/wsjf reports an unscored task as scored:false with null fields', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/wsjf`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.task_id).toBe(taskId);
    expect(body.scored).toBe(false);
    expect(body.components).toBeNull();
    expect(body.locked).toBeNull();
  });

  it('PUT /:id/wsjf sets components + locks (manual gate) and persists', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}/wsjf`,
      headers,
      payload: {
        value: 8,
        timeCriticality: 3,
        riskOpportunity: 5,
        jobSize: 2,
        locked: {
          value: true,
          timeCriticality: false,
          riskOpportunity: false,
          jobSize: false,
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.scored).toBe(true);
    expect(body.components).toEqual({
      value: 8,
      timeCriticality: 3,
      riskOpportunity: 5,
      jobSize: 2,
    });
    expect(body.locked.value).toBe(true);

    // Read-back round-trips the persisted state.
    const read = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/wsjf`,
      headers,
    });
    expect(read.json().components.value).toBe(8);
    expect(read.json().locked.value).toBe(true);
  });

  it('PUT /:id/wsjf rejects an off-scale Fibonacci tier (400) via the schema', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}/wsjf`,
      headers,
      payload: {
        value: 4, // off-scale
        timeCriticality: 3,
        riskOpportunity: 5,
        jobSize: 2,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PUT /:id/wsjf rejects the jobSize=1 ∧ value=13 contradiction (400, MCP gate)', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}/wsjf`,
      headers,
      payload: {
        value: 13,
        timeCriticality: 3,
        riskOpportunity: 5,
        jobSize: 1,
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    // The error body surfaces the shared contradiction rule message.
    expect(JSON.stringify(body)).toContain('contradiction');
  });

  it('GET /:id/score-history returns rows oldest-first after writes', async () => {
    // A second valid write appends another manual history row.
    await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}/wsjf`,
      headers,
      payload: {
        value: 5,
        timeCriticality: 3,
        riskOpportunity: 5,
        jobSize: 2,
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/score-history`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.task_id).toBe(taskId);
    expect(body.total).toBe(body.history.length);
    expect(body.history.length).toBeGreaterThanOrEqual(2);
    // Every row is a manual write; chronological (changed_at non-decreasing).
    for (const row of body.history) {
      expect(row.trigger).toBe('manual');
    }
    const times = body.history.map((r: { changed_at: string }) => r.changed_at);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
    // First write set value=8; the timeline preserves it.
    expect(body.history[0].value).toBe(8);
  });

  it('GET /:id/wsjf returns 404 for a missing task', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/99999/wsjf`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('GET /:id/score-history returns 404 for a missing task', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/99999/score-history`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('requires authentication (no x-api-key → 401)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}/wsjf`,
    });
    expect(response.statusCode).toBe(401);
  });
});
