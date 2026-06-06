import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';

// Phase 31 Plan 02 — POST /api/v1/tasks/:id/comments identity propagation.

const TEST_KEY = 'test-key-comment';
const TEST_LABEL = 'p31-02-comment';

describe('POST /api/v1/tasks/:id/comments — author_user_id injection', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let taskId: number;
  let legacyUserId: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    const project = app.projectService.createProject({ name: 'P31-02 comments' });
    const task = app.taskService.createTask({
      title: 'host task',
      project_id: project.id,
      created_by: 'seed',
    });
    taskId = task.id;
    const legacyUser = app.userRepository.findLegacyByDisplayName(TEST_LABEL);
    if (legacyUser === null) {
      throw new Error('expected legacy user seeded for ' + TEST_LABEL);
    }
    legacyUserId = legacyUser.id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    if (prevApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = prevApiKeys;
    }
  });

  function getCommentRow(id: number): {
    id: number;
    author: string;
    author_user_id: number | null;
  } {
    return db
      .prepare('SELECT id, author, author_user_id FROM task_comments WHERE id = ?')
      .get(id) as { id: number; author: string; author_user_id: number | null };
  }

  it('populates author_user_id = request.user.id on comment create', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      headers,
      payload: { author: 'Some Display', content: 'hello' },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    const row = getCommentRow(body.id);
    // Legacy TEXT column populated from body.author as today.
    expect(row.author).toBe('Some Display');
    // NEW: FK column populated from request.user.id.
    expect(row.author_user_id).toBe(legacyUserId);
  });

  it('IGNORES body-supplied author_user_id (T-31-02 spoof attempt)', async () => {
    const SPOOFED = 99999;
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/comments`,
      headers,
      payload: {
        author: 'alice',
        content: 'spoof attempt',
        author_user_id: SPOOFED,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    const row = getCommentRow(body.id);
    expect(row.author_user_id).toBe(legacyUserId);
    expect(row.author_user_id).not.toBe(SPOOFED);
  });
});
