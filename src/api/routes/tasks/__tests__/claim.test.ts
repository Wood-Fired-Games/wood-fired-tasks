import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';

// Phase 31 Plan 02 — POST /api/v1/tasks/:id/claim identity propagation tests.

const TEST_KEY = 'test-key-claim';
const TEST_LABEL = 'p31-02-claim';

describe('POST /api/v1/tasks/:id/claim — assignee_user_id injection', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let testProjectId: number;
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
    const project = app.projectService.createProject({ name: 'P31-02 claim' });
    testProjectId = project.id;
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

  function getTaskRow(id: number): {
    id: number;
    assignee: string | null;
    assignee_user_id: number | null;
  } {
    return db
      .prepare(
        'SELECT id, assignee, assignee_user_id FROM tasks WHERE id = ?',
      )
      .get(id) as {
      id: number;
      assignee: string | null;
      assignee_user_id: number | null;
    };
  }

  function createOpenTask(title: string) {
    return app.taskService.createTask({
      title,
      project_id: testProjectId,
      created_by: 'seed',
    });
  }

  it('populates assignee_user_id = request.user.id on successful claim', async () => {
    const task = createOpenTask('Claim FK propagation');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    // Legacy TEXT column populated as today.
    expect(row.assignee).toBe('agent-1');
    // NEW: FK column populated from request.user.id.
    expect(row.assignee_user_id).toBe(legacyUserId);
  });

  it('claim populates FK even when body.assignee is unrelated to the auth principal', async () => {
    // The assignee string is what the caller chose; assignee_user_id is the
    // actor (the user who clicked claim). They can differ (e.g. an agent
    // claims on behalf of a queue name). The FK reflects WHO claimed.
    const task = createOpenTask('Claim FK is the actor');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'queue-abc' },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    expect(row.assignee).toBe('queue-abc');
    expect(row.assignee_user_id).toBe(legacyUserId);
  });
});
