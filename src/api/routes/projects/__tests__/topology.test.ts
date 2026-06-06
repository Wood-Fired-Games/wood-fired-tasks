import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';

/**
 * Integration tests for GET /api/v1/projects/:id/topology.
 *
 * This route exposes `TopologyService.classify` over REST so the remote MCP
 * `topology_check` proxy can reach byte-for-byte parity with the stdio tool.
 *
 * Round-trip via `server.inject`:
 *   - FLAT project (no dependency edges) → topology=FLAT, advisory=/tasks:loop
 *   - DAG project (linear chain) → topology=DAG, advisory=/tasks:loop-dag,
 *     sorted edges/roots/leaves
 *   - DAG_CYCLIC project → topology=DAG_CYCLIC, advisory=BLOCKED
 *   - invalid project id (non-positive / non-numeric) → 400 via zod params
 *   - missing project id → 404 ProblemDetails (existence guard)
 *   - missing auth → 401
 */

const TEST_KEY = 'test-key-topology';
const TEST_LABEL = 'topology-route';

describe('GET /api/v1/projects/:id/topology', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let flatProjectId: number;
  let dagProjectId: number;
  let dagA: number;
  let dagB: number;
  let dagC: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    // FLAT project: two tasks, no dependency edges.
    const flat = app.projectService.createProject({ name: 'Topology FLAT' });
    flatProjectId = flat.id;
    app.taskService.createTask({
      title: 'flat-a',
      project_id: flatProjectId,
      priority: 'medium',
      created_by: 'seed',
    });
    app.taskService.createTask({
      title: 'flat-b',
      project_id: flatProjectId,
      priority: 'medium',
      created_by: 'seed',
    });

    // DAG project: linear chain a→b→c.
    const dag = app.projectService.createProject({ name: 'Topology DAG' });
    dagProjectId = dag.id;
    dagA = app.taskService.createTask({
      title: 'dag-a',
      project_id: dagProjectId,
      priority: 'urgent',
      created_by: 'seed',
    }).id;
    dagB = app.taskService.createTask({
      title: 'dag-b',
      project_id: dagProjectId,
      priority: 'high',
      created_by: 'seed',
    }).id;
    dagC = app.taskService.createTask({
      title: 'dag-c',
      project_id: dagProjectId,
      priority: 'medium',
      created_by: 'seed',
    }).id;
    app.dependencyService.addDependency({ task_id: dagA, blocks_task_id: dagB });
    app.dependencyService.addDependency({ task_id: dagB, blocks_task_id: dagC });
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (prevApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = prevApiKeys;
  });

  it('classifies a project with no edges as FLAT', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${flatProjectId}/topology`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.topology).toBe('FLAT');
    expect(body.advisory).toBe('/tasks:loop');
    expect(body.edges).toEqual([]);
    // Every node is both a root and a leaf in a FLAT project.
    expect(body.roots).toEqual(body.leaves);
    expect(body.roots).toHaveLength(2);
  });

  it('classifies a linear chain as DAG with sorted edges/roots/leaves', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${dagProjectId}/topology`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.topology).toBe('DAG');
    expect(body.advisory).toBe('/tasks:loop-dag');
    expect(body.edges).toEqual([
      { from: dagA, to: dagB },
      { from: dagB, to: dagC },
    ]);
    expect(body.roots).toEqual([dagA]);
    expect(body.leaves).toEqual([dagC]);
  });

  it('rejects a non-positive project id via zod params validation (400)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/0/topology`,
      headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-numeric project id via zod params validation (400)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/not-a-number/topology`,
      headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 404 ProblemDetails when project does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/99999/topology`,
      headers,
    });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error).toBe('NOT_FOUND');
    expect(body.details).toEqual({ entity: 'Project', id: 99999 });
  });

  it('requires authentication (no x-api-key header → 401)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${dagProjectId}/topology`,
    });
    expect(response.statusCode).toBe(401);
  });

  describe('DAG_CYCLIC handling', () => {
    let cyclicProjectId: number;
    beforeAll(() => {
      const p = app.projectService.createProject({ name: 'Topology Cyclic' });
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
      const stmt = app.db.prepare(
        "INSERT INTO task_dependencies (task_id, blocks_task_id, created_at) VALUES (?, ?, datetime('now'))",
      );
      stmt.run(t1.id, t2.id);
      stmt.run(t2.id, t3.id);
      stmt.run(t3.id, t1.id);
    });

    it('flags topology=DAG_CYCLIC with advisory=BLOCKED', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/projects/${cyclicProjectId}/topology`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.topology).toBe('DAG_CYCLIC');
      expect(body.advisory).toBe('BLOCKED');
      expect(body.edges).toHaveLength(3);
    });
  });
});
