import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';
import { authHeaders } from '../../../__tests__/helpers/auth.js';

/**
 * Integration tests for GET /api/v1/projects/:id/resolve-model (task #926).
 *
 * This route exposes `ModelPolicyService.resolveModel` over REST so the remote
 * MCP `resolve_model` proxy can reach byte-for-byte parity with the stdio tool.
 * The 200 body is the resolver output VERBATIM:
 *   `{ model }` | `{ model: 'auto' }` | `null` (inherit the session model).
 *
 * Round-trip via `server.inject`:
 *   - project with a per-project policy → `{ model }`
 *   - project with no policy but a global default → inherits `{ model }`
 *   - project + role with no policy at any layer → `null`
 *   - `auto` ref at a layer → `{ model: 'auto' }`
 *   - invalid params (bad role / non-positive id) → 400 via zod
 *   - missing project id → 404 ProblemDetails (existence guard)
 *   - missing auth → 401
 *   - task #928: in-project task_id → 200; nonexistent task_id → 404;
 *     task_id from a different project → 400 (no foreign jobSize routing)
 */

describe('GET /api/v1/projects/:id/resolve-model', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectWithPolicy: number;
  let projectNoPolicy: number;
  let taskInPolicyProject: number;
  let taskInOtherProject: number;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    headers = authHeaders(app.db);

    // A project with its own per-project policy (execution constant + planning auto).
    const withPolicy = app.projectService.createProject({ name: 'resolve-with-policy' });
    projectWithPolicy = withPolicy.id;
    app.projectService.updateProject(projectWithPolicy, {
      model_policy: {
        execution: { default: 'claude-opus' },
        planning: { constant: 'auto' },
      },
    });

    // A project with NO policy of its own — exercises global-default inheritance
    // and the null fall-through.
    const noPolicy = app.projectService.createProject({ name: 'resolve-no-policy' });
    projectNoPolicy = noPolicy.id;

    // Task #928 validation fixtures: one task in each project, so a task_id
    // can be exercised both in-project (happy path) and cross-project (400).
    taskInPolicyProject = app.taskService.createTask({
      title: 'resolve-model in-project task',
      project_id: projectWithPolicy,
      priority: 'medium',
      created_by: 'seed',
    }).id;
    taskInOtherProject = app.taskService.createTask({
      title: 'resolve-model foreign task',
      project_id: projectNoPolicy,
      priority: 'medium',
      created_by: 'seed',
    }).id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('returns the per-project resolved model verbatim ({ model })', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=execution`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ model: 'claude-opus' });
  });

  it('returns { model: "auto" } when the resolved ref is the auto sentinel', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=planning`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ model: 'auto' });
  });

  it('inherits the global default when the project configures no policy', async () => {
    app.settingsService.setModelPolicyDefault({ validation: { default: 'claude-haiku' } });
    try {
      const res = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${projectNoPolicy}/resolve-model?role=validation`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ model: 'claude-haiku' });
    } finally {
      app.settingsService.setModelPolicyDefault(null);
    }
  });

  it('returns null (inherit the session model) when no policy resolves at any layer', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectNoPolicy}/resolve-model?role=execution`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    // A literal JSON `null` body — the resolver's "inherit" sentinel.
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('rejects an invalid role with 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=bogus`,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-positive project id with 400', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/projects/0/resolve-model?role=execution',
      headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a missing project (existence guard)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/projects/999999/resolve-model?role=execution',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it('resolves normally for a task_id belonging to the project (task #928 regression)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=execution&task_id=${taskInPolicyProject}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ model: 'claude-opus' });
  });

  it('returns 404 for a nonexistent task_id (task #928 — no silent default routing)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=execution&task_id=999999`,
      headers,
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('NOT_FOUND');
    expect(body.details).toEqual({ entity: 'Task', id: 999999 });
  });

  it('returns 400 for a task_id belonging to a different project (task #928 — no foreign jobSize routing)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=execution&task_id=${taskInOtherProject}`,
      headers,
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual({
      task_id: [
        `Task ${taskInOtherProject} belongs to project ${projectNoPolicy}, not project ${projectWithPolicy}`,
      ],
    });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectWithPolicy}/resolve-model?role=execution`,
    });
    expect(res.statusCode).toBe(401);
  });
});
