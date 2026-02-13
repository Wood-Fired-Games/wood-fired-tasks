import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../server.js';
import type { App } from '../../index.js';

// Configure API keys for tests
process.env.API_KEYS = 'test-key';

describe('Error Handler', () => {
  let server: FastifyInstance;
  let app: App;
  let testProjectId: number;

  beforeEach(async () => {
    // Create server with in-memory database
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    // Create a test project for scenarios that need valid project_id
    const project = await app.projectService.createProject({
      name: 'Test Project',
      description: 'Test project for error tests',
      created_by: 'test-user',
    });
    testProjectId = project.id;
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
  });

  it('POST /api/v1/tasks with empty body returns 400 with VALIDATION_ERROR', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-api-key': 'test-key' },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');

    const body = JSON.parse(response.payload);
    expect(body.error).toMatch(/VALIDATION_ERROR|FST_ERR_VALIDATION/);
    expect(body.message).toBeDefined();
    expect(body.stack).toBeUndefined(); // No stack trace
  });

  it('GET /api/v1/tasks/99999 returns 404 with NOT_FOUND', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks/99999',
      headers: { 'x-api-key': 'test-key' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');

    const body = JSON.parse(response.payload);
    expect(body.error).toBe('NOT_FOUND');
    expect(body.message).toBeDefined();
    expect(body.details).toMatchObject({
      entity: 'Task',
      id: 99999,
    });
    expect(body.stack).toBeUndefined(); // No stack trace
  });

  it('POST /api/v1/tasks with non-existent project_id returns 422 with BUSINESS_RULE_VIOLATION', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'x-api-key': 'test-key' },
      payload: {
        title: 'Test Task',
        project_id: 99999, // Non-existent project
        created_by: 'test-user',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain('application/json');

    const body = JSON.parse(response.payload);
    expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
    expect(body.message).toContain('Project');
    expect(body.stack).toBeUndefined(); // No stack trace
  });

  it('PUT /api/v1/tasks/:id with invalid status transition returns 422', async () => {
    // Create a task in 'open' status
    const task = await app.taskService.createTask({
      title: 'Test Task',
      project_id: testProjectId,
      created_by: 'test-user',
    });

    // Try invalid transition: open -> done (skipping in_progress)
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers: { 'x-api-key': 'test-key' },
      payload: {
        status: 'done',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain('application/json');

    const body = JSON.parse(response.payload);
    expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
    expect(body.message).toContain('status');
    expect(body.stack).toBeUndefined(); // No stack trace
  });

  it('GET /api/v1/projects/99999 returns 404 with NOT_FOUND', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects/99999',
      headers: { 'x-api-key': 'test-key' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');

    const body = JSON.parse(response.payload);
    expect(body.error).toBe('NOT_FOUND');
    expect(body.message).toBeDefined();
    expect(body.details).toMatchObject({
      entity: 'Project',
      id: 99999,
    });
    expect(body.stack).toBeUndefined(); // No stack trace
  });

  it('POST /api/v1/projects with duplicate name returns 422 with BUSINESS_RULE_VIOLATION', async () => {
    // Create first project
    await app.projectService.createProject({
      name: 'Duplicate Project',
      created_by: 'test-user',
    });

    // Try to create project with same name
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { 'x-api-key': 'test-key' },
      payload: {
        name: 'Duplicate Project',
        created_by: 'test-user',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.headers['content-type']).toContain('application/json');

    const body = JSON.parse(response.payload);
    expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
    expect(body.message).toContain('already exists');
    expect(body.stack).toBeUndefined(); // No stack trace
  });

  it('All error responses have Content-Type: application/json', async () => {
    const responses = await Promise.all([
      server.inject({
        method: 'GET',
        url: '/api/v1/tasks/99999',
        headers: { 'x-api-key': 'test-key' },
      }),
      server.inject({
        method: 'GET',
        url: '/api/v1/projects/99999',
        headers: { 'x-api-key': 'test-key' },
      }),
    ]);

    for (const response of responses) {
      expect(response.headers['content-type']).toContain('application/json');
    }
  });

  it('No error response contains a stack trace', async () => {
    const responses = await Promise.all([
      server.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': 'test-key' },
        payload: {},
      }),
      server.inject({
        method: 'GET',
        url: '/api/v1/tasks/99999',
        headers: { 'x-api-key': 'test-key' },
      }),
      server.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { 'x-api-key': 'test-key' },
        payload: {
          name: 'Duplicate Project',
          created_by: 'test-user',
        },
      }),
    ]);

    for (const response of responses) {
      const body = JSON.parse(response.payload);
      expect(body.stack).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('at '); // No stack trace lines
    }
  });
});
