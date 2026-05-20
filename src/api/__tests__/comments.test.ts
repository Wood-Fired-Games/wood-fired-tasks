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
    expect(body).toMatchObject({ limit: 50, offset: 0 });
    expect(body.total).toBe(3);
    expect(body.data).toHaveLength(3);
    expect(body.data[0].content).toBe('First comment');
    expect(body.data[1].content).toBe('Second comment');
    expect(body.data[2].content).toBe('Third comment');
  });

  it('paginates comments with limit/offset', async () => {
    const project = app.projectService.createProject({ name: 'Comment pagination project' });
    const task = app.taskService.createTask({
      title: 'Task with many comments',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    // Seed 6 comments
    for (let i = 0; i < 6; i++) {
      app.commentService.addComment({
        task_id: task.id,
        author: `User ${i + 1}`,
        content: `Comment number ${i + 1}`,
      });
    }

    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/comments?limit=2&offset=2`,
      headers: { 'X-API-Key': apiKey },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(6);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  it('rejects limit > 500 with 400 on comments', async () => {
    const project = app.projectService.createProject({ name: 'Comment 400 project' });
    const task = app.taskService.createTask({
      title: 'T',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}/comments?limit=501`,
      headers: { 'X-API-Key': apiKey },
    });
    expect(response.statusCode).toBe(400);
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

  // Regression for task 191 (IDOR audit, security.md SEV-MEDIUM #1).
  // DELETE /tasks/:id/comments/:commentId must enforce that the comment
  // actually belongs to the task in the URL — otherwise a caller can delete
  // any comment id by supplying any task id.
  it('should return 404 when deleting comment via wrong task id', async () => {
    const project = app.projectService.createProject({ name: 'Test Project' });
    const taskA = app.taskService.createTask({
      title: 'Task A',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });
    const taskB = app.taskService.createTask({
      title: 'Task B',
      priority: 'medium',
      project_id: project.id,
      created_by: 'test-user',
    });

    // Comment belongs to Task A.
    const comment = app.commentService.addComment({
      task_id: taskA.id,
      author: 'Test User',
      content: 'Owned by Task A',
    });

    // Attempt to delete via Task B's URL — must 404.
    const wrongTaskResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${taskB.id}/comments/${comment.id}`,
      headers: { 'X-API-Key': apiKey },
    });
    expect(wrongTaskResponse.statusCode).toBe(404);

    // Attempt to delete via a task id that does not exist — must 404.
    const missingTaskResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/99999/comments/${comment.id}`,
      headers: { 'X-API-Key': apiKey },
    });
    expect(missingTaskResponse.statusCode).toBe(404);

    // Comment must still exist after the failed cross-task deletes.
    expect(app.commentService.getComments(taskA.id)).toHaveLength(1);

    // Happy path with the correct task id still returns 204.
    const correctResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/tasks/${taskA.id}/comments/${comment.id}`,
      headers: { 'X-API-Key': apiKey },
    });
    expect(correctResponse.statusCode).toBe(204);
    expect(app.commentService.getComments(taskA.id)).toHaveLength(0);
  });
});
