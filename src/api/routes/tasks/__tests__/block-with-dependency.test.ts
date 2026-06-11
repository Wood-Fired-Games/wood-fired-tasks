// Task #1004: atomic block-with-dependency over the REST transport.
//
// PUT /api/v1/tasks/:id accepts `blocked_by: number[]` alongside
// `status: 'blocked'` — the route's UpdateTaskClientSchema body admits the
// field and the service commits the edge add(s) and the status flip in one
// transaction. These tests pin the REST surface; the transactional semantics
// themselves are pinned in src/services/__tests__/block-with-dependency.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../../../index.js';
import { authHeaders } from '../../../__tests__/helpers/auth.js';

describe('PUT /api/v1/tasks/:id — blocked_by (atomic block-with-dependency, #1004)', () => {
  let server: FastifyInstance;
  let app: App;
  let testProjectId: number;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    headers = authHeaders(app.db);
    testProjectId = app.projectService.createProject({ name: 'Block-with-dep REST' }).id;
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
  });

  function createTask(title: string): number {
    return app.taskService.createTask({
      title,
      project_id: testProjectId,
      created_by: 'rest-tester',
    }).id;
  }

  it('blocks the task and adds the edge in one PUT', async () => {
    const victim = createTask('victim');
    const blocker = createTask('defect');

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${victim}`,
      headers,
      payload: { status: 'blocked', blocked_by: [blocker] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('blocked');
    expect(app.dependencyService.getBlockers(victim).map((d) => d.task_id)).toEqual([blocker]);
  });

  it('rejects blocked_by without status: blocked and leaves the task untouched', async () => {
    const victim = createTask('victim 2');
    const blocker = createTask('defect 2');

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${victim}`,
      headers,
      payload: { blocked_by: [blocker] },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(app.taskService.getTask(victim).status).toBe('open');
    expect(app.dependencyService.getBlockers(victim)).toEqual([]);
  });

  it('rolls back both status and edges when one blocker does not exist', async () => {
    const victim = createTask('victim 3');
    const validBlocker = createTask('defect 3');

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${victim}`,
      headers,
      payload: { status: 'blocked', blocked_by: [validBlocker, 999_999] },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(app.taskService.getTask(victim).status).toBe('open');
    expect(app.dependencyService.getBlockers(victim)).toEqual([]);
  });
});
