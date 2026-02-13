import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';

describe('Comment API Routes', () => {
  let server: FastifyInstance;
  let app: App;
  const apiKey = 'test-api-key-12345';

  beforeEach(async () => {
    // Set API key
    process.env.API_KEYS = apiKey;

    // Create server with in-memory database
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    app.db.close();
    delete process.env.API_KEYS;
  });

  it('should create a comment and return 201', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { 'X-API-Key': apiKey },
      payload: {
        author: 'John Doe',
        content: 'This is a test comment',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.task_id).toBe(task.id);
    expect(body.author).toBe('John Doe');
    expect(body.content).toBe('This is a test comment');
    expect(body.created_at).toBeTruthy();
    expect(body.updated_at).toBeNull();
  });

  it('should get comments in chronological order', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    // Create 3 comments
    app.commentService.addComment({
      task_id: task.id,
      author: 'User 1',
      content: 'First comment',
    });
    app.commentService.addComment({
      task_id: task.id,
      author: 'User 2',
      content: 'Second comment',
    });
    app.commentService.addComment({
      task_id: task.id,
      author: 'User 3',
      content: 'Third comment',
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { 'X-API-Key': apiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(3);
    expect(body[0].content).toBe('First comment');
    expect(body[1].content).toBe('Second comment');
    expect(body[2].content).toBe('Third comment');
  });

  it('should delete a comment and return 204', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    const comment = app.commentService.addComment({
      task_id: task.id,
      author: 'Test User',
      content: 'To be deleted',
    });

    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${task.id}/comments/${comment.id}`,
      headers: { 'X-API-Key': apiKey },
    });

    expect(response.statusCode).toBe(204);

    // Verify comment is gone
    const comments = app.commentService.getComments(task.id);
    expect(comments).toHaveLength(0);
  });

  it('should return 404 for comment on nonexistent task', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/99999/comments`,
      headers: { 'X-API-Key': apiKey },
      payload: {
        author: 'Test User',
        content: 'Comment on missing task',
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('should return 400 for comment with empty content', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const task = app.taskService.createTask({
      title: 'Task 1',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { 'X-API-Key': apiKey },
      payload: {
        author: 'Test User',
        content: '',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should require authentication', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/1/comments`,
    });

    expect(response.statusCode).toBe(401);
  });
});
