import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';
import { authHeaders } from './helpers/auth.js';

describe('Dependency API Routes', () => {
  let server: FastifyInstance;
  let app: App;
  let auth: { Authorization: string };

  beforeEach(async () => {
    // Create server with in-memory database
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    await server.ready();

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    auth = authHeaders(app.db);
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
  });

  it('should create a dependency and return 201', async () => {
    // Create project and two tasks
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task1 = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const task2 = app.taskService.createTask({
      title: 'Task 2',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task1.id}/dependencies`,
      headers: auth,
      payload: { blocks_task_id: task2.id },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.task_id).toBe(task1.id);
    expect(body.blocks_task_id).toBe(task2.id);
  });

  it('should reject circular dependency with 422', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task1 = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const task2 = app.taskService.createTask({
      title: 'Task 2',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    // Create A -> B
    app.dependencyService.addDependency({
      task_id: task1.id,
      blocks_task_id: task2.id,
    });

    // Try to create B -> A (circular)
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task2.id}/dependencies`,
      headers: auth,
      payload: { blocks_task_id: task1.id },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
    expect(body.message).toContain('circular');
  });

  it('should get dependencies for a task', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task1 = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const task2 = app.taskService.createTask({
      title: 'Task 2',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const task3 = app.taskService.createTask({
      title: 'Task 3',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    // Task1 blocks Task2, Task3 blocks Task1
    app.dependencyService.addDependency({
      task_id: task1.id,
      blocks_task_id: task2.id,
    });
    app.dependencyService.addDependency({
      task_id: task3.id,
      blocks_task_id: task1.id,
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task1.id}/dependencies`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0].blocks_task_id).toBe(task2.id);
    expect(body.blocked_by).toHaveLength(1);
    expect(body.blocked_by[0].task_id).toBe(task3.id);
  });

  it('should delete a dependency and return 204', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task1 = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const task2 = app.taskService.createTask({
      title: 'Task 2',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    app.dependencyService.addDependency({
      task_id: task1.id,
      blocks_task_id: task2.id,
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${task1.id}/dependencies/${task2.id}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(204);

    // Verify dependency is gone
    const deps = app.dependencyService.getBlockers(task1.id);
    expect(deps).toHaveLength(0);
  });

  it('should return 404 for dependency on nonexistent task', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/99999/dependencies`,
      headers: auth,
      payload: { blocks_task_id: 88888 },
    });

    expect(response.statusCode).toBe(404);
  });

  it('should require authentication', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/1/dependencies`,
    });

    expect(response.statusCode).toBe(401);
  });
});
