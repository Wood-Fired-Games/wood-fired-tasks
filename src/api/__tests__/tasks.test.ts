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

  it('should list all tasks with GET /tasks', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('should filter tasks by status', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks?status=open',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    body.forEach((task: any) => {
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
    const subtasks = JSON.parse(response.body);
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
});
