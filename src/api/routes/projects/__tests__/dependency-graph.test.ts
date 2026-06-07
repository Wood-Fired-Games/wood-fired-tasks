import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';
import { authHeaders } from '../../../__tests__/helpers/auth.js';

/**
 * Task #342 — integration tests for GET /api/v1/projects/:id/dependency-graph.
 *
 * Round-trip via `server.inject`:
 *   - format=tree (default and explicit)
 *   - format=graph
 *   - format=text
 *   - 404 when project missing
 *   - cycle handling reports `DAG_CYCLIC` without hanging the request
 */

describe('GET /api/v1/projects/:id/dependency-graph', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;
  let aId: number;
  let bId: number;
  let cId: number;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    headers = authHeaders(app.db);

    // Seed a small DAG: a→b, b→c (linear chain).
    const project = app.projectService.createProject({
      name: 'Dependency Graph Test Project',
    });
    projectId = project.id;
    const a = app.taskService.createTask({
      title: 'task a',
      project_id: projectId,
      priority: 'urgent',
      created_by: 'seed',
    });
    aId = a.id;
    const b = app.taskService.createTask({
      title: 'task b',
      project_id: projectId,
      priority: 'high',
      created_by: 'seed',
    });
    bId = b.id;
    const c = app.taskService.createTask({
      title: 'task c',
      project_id: projectId,
      priority: 'medium',
      created_by: 'seed',
    });
    cId = c.id;
    app.dependencyService.addDependency({ task_id: aId, blocks_task_id: bId });
    app.dependencyService.addDependency({ task_id: bId, blocks_task_id: cId });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('returns tree shape by default (no ?format= query param)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/dependency-graph`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.format).toBe('tree');
    expect(body.topology).toBe('DAG');
    expect(body.total_tasks).toBe(3);
    expect(body.total_edges).toBe(2);
    expect(Array.isArray(body.roots)).toBe(true);
    expect(body.roots).toHaveLength(1);
    expect(body.roots[0].id).toBe(aId);
    expect(body.roots[0].children[0].id).toBe(bId);
    expect(body.roots[0].children[0].children[0].id).toBe(cId);
  });

  it('returns tree shape when ?format=tree is explicit', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/dependency-graph?format=tree`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.format).toBe('tree');
    expect(body.roots[0].id).toBe(aId);
  });

  it('returns graph shape with nodes and edges', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/dependency-graph?format=graph`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.format).toBe('graph');
    expect(body.topology).toBe('DAG');
    expect(body.total_tasks).toBe(3);
    expect(body.total_edges).toBe(2);
    expect(body.nodes).toHaveLength(3);
    expect(body.edges).toEqual([
      { from: aId, to: bId },
      { from: bId, to: cId },
    ]);
    // Nodes carry only the compact projection {id, title, status, priority}.
    expect(Object.keys(body.nodes[0]).sort()).toEqual(['id', 'priority', 'status', 'title'].sort());
  });

  it('returns text shape with pre-rendered box-drawing lines', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/dependency-graph?format=text`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.format).toBe('text');
    expect(body.topology).toBe('DAG');
    expect(body.total_tasks).toBe(3);
    expect(body.total_edges).toBe(2);
    expect(body.lines).toHaveLength(3);
    // Root line — no connector.
    expect(body.lines[0]).toMatch(/^#\d+ ○ task a \(urgent\)$/);
    // Child / grandchild rendered with `└──`.
    expect(body.lines[1]).toContain('└──');
    expect(body.lines[1]).toContain('task b');
    expect(body.lines[2]).toContain('└──');
    expect(body.lines[2]).toContain('task c');
  });

  it('rejects invalid ?format= query value via zod validation', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/dependency-graph?format=invalid`,
      headers,
    });
    // Zod rejects unknown enum values at the route layer.
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 ProblemDetails when project does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/99999/dependency-graph`,
      headers,
    });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    // Mirrors the existing project-404 contract (see error-handler.ts).
    expect(body.error).toBe('NOT_FOUND');
    expect(body.details).toEqual({ entity: 'Project', id: 99999 });
  });

  it('requires authentication (no x-api-key header → 401)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/dependency-graph`,
    });
    expect(response.statusCode).toBe(401);
  });

  describe('empty project', () => {
    let emptyProjectId: number;
    beforeAll(() => {
      emptyProjectId = app.projectService.createProject({
        name: 'Empty Dep Graph Project',
      }).id;
    });

    it('tree shape returns empty arrays + total_tasks/edges zero', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${emptyProjectId}/dependency-graph?format=tree`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.roots).toEqual([]);
      expect(body.total_tasks).toBe(0);
      expect(body.total_edges).toBe(0);
      expect(body.topology).toBe('FLAT');
    });

    it('graph shape returns empty nodes+edges', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${emptyProjectId}/dependency-graph?format=graph`,
        headers,
      });
      const body = response.json();
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);
      expect(body.topology).toBe('FLAT');
    });

    it('text shape returns empty lines array', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${emptyProjectId}/dependency-graph?format=text`,
        headers,
      });
      const body = response.json();
      expect(body.lines).toEqual([]);
      expect(body.topology).toBe('FLAT');
    });
  });

  describe('DAG_CYCLIC handling', () => {
    let cyclicProjectId: number;
    beforeAll(() => {
      const p = app.projectService.createProject({ name: 'Cyclic Project' });
      cyclicProjectId = p.id;
      const t1 = app.taskService.createTask({
        title: 'cyc-a',
        project_id: cyclicProjectId,
        priority: 'medium',
        created_by: 'seed',
      });
      const t2 = app.taskService.createTask({
        title: 'cyc-b',
        project_id: cyclicProjectId,
        priority: 'medium',
        created_by: 'seed',
      });
      const t3 = app.taskService.createTask({
        title: 'cyc-c',
        project_id: cyclicProjectId,
        priority: 'medium',
        created_by: 'seed',
      });
      // Seed the cycle directly via the raw repo (DependencyService refuses).
      app.db
        .prepare(
          "INSERT INTO task_dependencies (task_id, blocks_task_id, created_at) VALUES (?, ?, datetime('now'))",
        )
        .run(t1.id, t2.id);
      app.db
        .prepare(
          "INSERT INTO task_dependencies (task_id, blocks_task_id, created_at) VALUES (?, ?, datetime('now'))",
        )
        .run(t2.id, t3.id);
      app.db
        .prepare(
          "INSERT INTO task_dependencies (task_id, blocks_task_id, created_at) VALUES (?, ?, datetime('now'))",
        )
        .run(t3.id, t1.id);
    });

    it('flags topology=DAG_CYCLIC and emits a synthetic root (N1)', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${cyclicProjectId}/dependency-graph?format=tree`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.topology).toBe('DAG_CYCLIC');
      expect(body.total_tasks).toBe(3);
      expect(body.total_edges).toBe(3);
      // N1: cyclic-only projects now get a synthetic root so the dashboard
      // panel doesn't render blank. Per-branch visited-set still bounds
      // the walk on the 3-cycle (3 visits, no infinite recursion).
      expect(body.roots.length).toBe(1);
      expect(body.truncated).toBe(false);
    });

    it('flags topology=DAG_CYCLIC and emits synthetic-root text (N1)', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${cyclicProjectId}/dependency-graph?format=text`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.topology).toBe('DAG_CYCLIC');
      // N1: synthetic root walked under per-branch visited-set bounds the
      // text output at 4 lines (root + 2 fresh descendants + 1 terminal
      // "already-visited" emit closing the 3-cycle).
      expect(body.lines.length).toBe(4);
      expect(body.truncated).toBe(false);
    });

    it('graph shape still returns all nodes + edges with DAG_CYCLIC flag', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${cyclicProjectId}/dependency-graph?format=graph`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.topology).toBe('DAG_CYCLIC');
      expect(body.nodes).toHaveLength(3);
      expect(body.edges).toHaveLength(3);
    });
  });
});
