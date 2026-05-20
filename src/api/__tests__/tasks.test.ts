import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { App } from '../../index.js';

// Set API key for tests
process.env.API_KEYS = 'test-key';

describe('Task CRUD Routes', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  const headers = { 'x-api-key': 'test-key' };
  let testProjectId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    // Create a test project
    const project = app.projectService.createProject({ name: 'Test Project' });
    testProjectId = project.id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('should create a task and return 201 with task object', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Test Task',
        description: 'Test description',
        priority: 'high',
        project_id: testProjectId,
        created_by: 'test-user',
        tags: ['test', 'api'],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.id).toBeDefined();
    expect(body.title).toBe('Test Task');
    expect(body.status).toBe('open');
    // Tags are returned in alphabetical order from the database
    expect(body.tags).toEqual(['api', 'test']);
  });

  it('should return error when creating task with missing title', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });

    // Accept either 400 (Fastify schema validation) or 500 (service validation)
    expect([400, 500]).toContain(response.statusCode);
  });

  it('should list all tasks with GET /tasks (paginated envelope)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // GET /tasks now returns `{ data, total, limit, offset }`.
    expect(body).toMatchObject({
      limit: 50,
      offset: 0,
    });
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('should filter tasks by status (envelope)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks?status=open',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body.data)).toBe(true);
    body.data.forEach((task: any) => {
      expect(task.status).toBe('open');
    });
  });

  it('should get a single task by ID', async () => {
    // Create a task first
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Get Test Task',
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });
    const created = JSON.parse(createResponse.body);

    // Get the task
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(created.id);
    expect(body.title).toBe('Get Test Task');
  });

  it('should return error for non-existent task ID', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/99999',
      headers,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should update a task and return 200', async () => {
    // Create a task first
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Update Test Task',
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });
    const created = JSON.parse(createResponse.body);

    // Update the task
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${created.id}`,
      headers,
      payload: {
        title: 'Updated Title',
        status: 'in_progress',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.title).toBe('Updated Title');
    expect(body.status).toBe('in_progress');
  });

  it('should delete a task and return 204', async () => {
    // Create a task first
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Delete Test Task',
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });
    const created = JSON.parse(createResponse.body);

    // Delete the task
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });

    expect(response.statusCode).toBe(204);
  });

  it('should return error when deleting already deleted task', async () => {
    // Create and delete a task
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Double Delete Test Task',
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });
    const created = JSON.parse(createResponse.body);

    await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });

    // Try to delete again
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('should return subtasks for a parent task', async () => {
    // Create parent task
    const parentResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Parent Task',
        priority: 'medium',
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });
    const parent = JSON.parse(parentResponse.body);

    // Create child tasks
    await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Child Task 1',
        priority: 'medium',
        project_id: testProjectId,
        parent_task_id: parent.id,
        created_by: 'test-user',
      },
    });
    await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Child Task 2',
        priority: 'medium',
        project_id: testProjectId,
        parent_task_id: parent.id,
        created_by: 'test-user',
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${parent.id}/subtasks`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Subtasks endpoint also returns the paginated envelope.
    expect(body).toMatchObject({ limit: 50, offset: 0 });
    expect(typeof body.total).toBe('number');
    const subtasks = body.data;
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0].title).toBe('Child Task 1');
    expect(subtasks[1].title).toBe('Child Task 2');
    expect(subtasks[0].parent_task_id).toBe(parent.id);
  });

  it('should include parent_task_id in task response', async () => {
    const parentResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Parent Task',
        priority: 'medium',
        project_id: testProjectId,
        created_by: 'test-user',
      },
    });
    const parent = JSON.parse(parentResponse.body);

    const childResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Child Task',
        priority: 'medium',
        project_id: testProjectId,
        parent_task_id: parent.id,
        created_by: 'test-user',
      },
    });

    expect(childResponse.statusCode).toBe(201);
    const child = JSON.parse(childResponse.body);
    expect(child.parent_task_id).toBe(parent.id);

    // Parent should have null parent_task_id
    expect(parent.parent_task_id).toBeNull();
  });

  it('should include estimated_minutes in task response', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Task with estimate',
        priority: 'medium',
        project_id: testProjectId,
        estimated_minutes: 120,
        created_by: 'test-user',
      },
    });

    expect(response.statusCode).toBe(201);
    const task = JSON.parse(response.body);
    expect(task.estimated_minutes).toBe(120);
  });

  it('should return estimated_minutes in GET task', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Task with estimate',
        priority: 'medium',
        project_id: testProjectId,
        estimated_minutes: 60,
        created_by: 'test-user',
      },
    });
    const created = JSON.parse(createResponse.body);

    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });

    expect(getResponse.statusCode).toBe(200);
    const task = JSON.parse(getResponse.body);
    expect(task.estimated_minutes).toBe(60);
  });

  describe('updated_after / updated_before filters', () => {
    let isolatedProjectId: number;
    let earlyId: number;
    let midId: number;
    let lateId: number;

    beforeAll(async () => {
      // Isolated project so the new filter tests don't compete with tasks
      // created by earlier `it` blocks in this file.
      const project = app.projectService.createProject({
        name: 'updated_at filter test project',
      });
      isolatedProjectId = project.id;

      // Create three tasks then stamp deterministic updated_at values so the
      // range bounds are stable regardless of test wall-clock timing.
      const create = async (title: string) => {
        const res = await server.inject({
          method: 'POST',
          url: '/api/v1/tasks',
          headers,
          payload: {
            title,
            project_id: isolatedProjectId,
            created_by: 'test-user',
          },
        });
        return JSON.parse(res.body).id as number;
      };

      earlyId = await create('Early task');
      midId = await create('Mid task');
      lateId = await create('Late task');

      const stamp = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
      stamp.run('2026-01-01T00:00:00.000Z', earlyId);
      stamp.run('2026-06-15T12:30:00.000Z', midId);
      stamp.run('2026-12-31T23:59:59.000Z', lateId);
    });

    it('returns ISO-8601 updated_at with T and Z', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tasks/${midId}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const task = JSON.parse(response.body);
      expect(task.updated_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
      );
    });

    it('normalizes SQLite-format updated_at to ISO-8601 on response', async () => {
      // Simulate a row written by SQLite's datetime('now') (no T, no Z).
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(
        '2026-06-15 12:30:00',
        midId
      );

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tasks/${midId}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const task = JSON.parse(response.body);
      expect(task.updated_at).toBe('2026-06-15T12:30:00.000Z');

      // Restore canonical value for subsequent range-filter tests.
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(
        '2026-06-15T12:30:00.000Z',
        midId
      );
    });

    it('filters with updated_after (inclusive lower bound)', async () => {
      const response = await server.inject({
        method: 'GET',
        url:
          `/api/v1/tasks?project_id=${isolatedProjectId}` +
          `&updated_after=2026-06-15T12:30:00.000Z`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ id: number }> };
      const ids = body.data.map((t) => t.id).sort();
      expect(ids).toEqual([midId, lateId].sort());
    });

    it('filters with updated_before (inclusive upper bound)', async () => {
      const response = await server.inject({
        method: 'GET',
        url:
          `/api/v1/tasks?project_id=${isolatedProjectId}` +
          `&updated_before=2026-06-15T12:30:00.000Z`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ id: number }> };
      const ids = body.data.map((t) => t.id).sort();
      expect(ids).toEqual([earlyId, midId].sort());
    });

    it('narrows correctly when updated_after and updated_before are combined', async () => {
      const response = await server.inject({
        method: 'GET',
        url:
          `/api/v1/tasks?project_id=${isolatedProjectId}` +
          `&updated_after=2026-03-01T00:00:00.000Z` +
          `&updated_before=2026-09-01T00:00:00.000Z`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ id: number }> };
      const ids = body.data.map((t) => t.id);
      expect(ids).toEqual([midId]);
    });

    it('composes with status filter', async () => {
      // Move the mid task to "done" so the combined filter has a unique hit.
      await server.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${midId}`,
        headers,
        payload: { status: 'in_progress' },
      });
      await server.inject({
        method: 'PUT',
        url: `/api/v1/tasks/${midId}`,
        headers,
        payload: { status: 'done' },
      });
      // updated_at moved to "now" by the PUT; re-stamp deterministically.
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(
        '2026-06-15T12:30:00.000Z',
        midId
      );

      const response = await server.inject({
        method: 'GET',
        url:
          `/api/v1/tasks?project_id=${isolatedProjectId}` +
          `&status=done` +
          `&updated_after=2026-03-01T00:00:00.000Z` +
          `&updated_before=2026-09-01T00:00:00.000Z`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ id: number; status: string }>;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(midId);
      expect(body.data[0].status).toBe('done');
    });

    it('rejects invalid updated_after datetime with 400', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks?updated_after=not-a-date',
        headers,
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects invalid updated_before datetime with 400', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks?updated_before=2026-13-99',
        headers,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('pagination (limit/offset)', () => {
    let paginationProjectId: number;
    const TOTAL = 12;

    beforeAll(async () => {
      const project = app.projectService.createProject({
        name: 'Pagination Test Project',
      });
      paginationProjectId = project.id;
      // Seed N tasks so we can exercise multiple pages.
      for (let i = 0; i < TOTAL; i++) {
        app.taskService.createTask({
          title: `Pagination task ${i + 1}`,
          project_id: paginationProjectId,
          created_by: 'pagination-tester',
        });
      }
    });

    it('returns the paginated envelope with default limit=50, offset=0', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tasks?project_id=${paginationProjectId}`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: unknown[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(body).toMatchObject({ limit: 50, offset: 0 });
      expect(body.total).toBe(TOTAL);
      expect(body.data).toHaveLength(TOTAL);
    });

    it('respects custom limit and offset', async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tasks?project_id=${paginationProjectId}&limit=5&offset=3`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ id: number }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.limit).toBe(5);
      expect(body.offset).toBe(3);
      expect(body.total).toBe(TOTAL);
      expect(body.data).toHaveLength(5);
    });

    it('does not duplicate rows across pages', async () => {
      const page1 = (await server.inject({
        method: 'GET',
        url: `/api/v1/tasks?project_id=${paginationProjectId}&limit=5&offset=0`,
        headers,
      })).json() as { data: Array<{ id: number }> };
      const page2 = (await server.inject({
        method: 'GET',
        url: `/api/v1/tasks?project_id=${paginationProjectId}&limit=5&offset=5`,
        headers,
      })).json() as { data: Array<{ id: number }> };

      const ids1 = new Set(page1.data.map((t) => t.id));
      const ids2 = new Set(page2.data.map((t) => t.id));
      const overlap = [...ids1].filter((id) => ids2.has(id));
      expect(overlap).toEqual([]);
    });

    it('rejects limit > 500 with 400', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks?limit=501',
        headers,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects negative offset with 400', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks?offset=-1',
        headers,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects limit=0 with 400', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks?limit=0',
        headers,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects non-numeric limit with 400', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks?limit=abc',
        headers,
      });
      expect(response.statusCode).toBe(400);
    });

    it('applies pagination to subtasks endpoint', async () => {
      // Create a parent + 8 children
      const parent = app.taskService.createTask({
        title: 'Subtask pagination parent',
        project_id: paginationProjectId,
        created_by: 'pagination-tester',
      });
      for (let i = 0; i < 8; i++) {
        app.taskService.createTask({
          title: `Sub ${i + 1}`,
          project_id: paginationProjectId,
          parent_task_id: parent.id,
          created_by: 'pagination-tester',
        });
      }

      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tasks/${parent.id}/subtasks?limit=3&offset=2`,
        headers,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: unknown[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.total).toBe(8);
      expect(body.limit).toBe(3);
      expect(body.offset).toBe(2);
      expect(body.data).toHaveLength(3);
    });
  });
});
