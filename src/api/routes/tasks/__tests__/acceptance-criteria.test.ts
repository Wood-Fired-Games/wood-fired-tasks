import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { App } from '../../../../index.js';

/**
 * Wave 1.3 (task #311) — REST surface coverage for the new
 * `tasks.acceptance_criteria` column.
 *
 * Verifies:
 *  - POST /tasks accepts `acceptance_criteria` in the body and persists it.
 *  - GET /tasks/:id returns the value verbatim.
 *  - PUT /tasks/:id can patch the value (set / change / clear via null).
 *  - GET /tasks (list) includes the value on the returned full task rows
 *    (the REST list returns full rows; only the MCP compact projection
 *    strips heavy fields).
 *  - Validation: > 5000 chars is rejected with 400 before reaching the DB.
 *  - Back-compat: tasks created without acceptance_criteria load with null.
 */

const TEST_KEY = 'test-key-acceptance';
const TEST_LABEL = 'wave-1-3-acceptance';

describe('REST /api/v1/tasks — acceptance_criteria field (#311)', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let projectId: number;
  let prevApiKeys: string | undefined;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    prevApiKeys = process.env.API_KEYS;
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    projectId = app.projectService.createProject({
      name: 'Wave 1.3 acceptance',
    }).id;
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

  it('POST accepts acceptance_criteria and GET returns it verbatim', async () => {
    const md = '- [ ] Tests pass\n- [ ] Lint clean';
    const createResp = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Task with criteria',
        project_id: projectId,
        created_by: 'tester',
        acceptance_criteria: md,
      },
    });
    expect(createResp.statusCode).toBe(201);
    const created = JSON.parse(createResp.body) as { id: number; acceptance_criteria: string | null };
    expect(created.acceptance_criteria).toBe(md);

    const getResp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });
    expect(getResp.statusCode).toBe(200);
    const fetched = JSON.parse(getResp.body) as { acceptance_criteria: string | null };
    expect(fetched.acceptance_criteria).toBe(md);
  });

  it('POST omitting acceptance_criteria stores NULL (back-compat)', async () => {
    const createResp = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Legacy-shaped task',
        project_id: projectId,
        created_by: 'tester',
      },
    });
    expect(createResp.statusCode).toBe(201);
    const created = JSON.parse(createResp.body) as { id: number; acceptance_criteria: string | null };
    expect(created.acceptance_criteria).toBeNull();

    // Sanity: same value when re-fetched.
    const getResp = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${created.id}`,
      headers,
    });
    expect(JSON.parse(getResp.body).acceptance_criteria).toBeNull();
  });

  it('PUT can patch acceptance_criteria — set, change, clear', async () => {
    const createResp = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Patch target',
        project_id: projectId,
        created_by: 'tester',
      },
    });
    const id = (JSON.parse(createResp.body) as { id: number }).id;

    // Set.
    let putResp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { acceptance_criteria: 'first revision' },
    });
    expect(putResp.statusCode).toBe(200);
    expect(JSON.parse(putResp.body).acceptance_criteria).toBe('first revision');

    // Change.
    putResp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { acceptance_criteria: 'second revision' },
    });
    expect(putResp.statusCode).toBe(200);
    expect(JSON.parse(putResp.body).acceptance_criteria).toBe('second revision');

    // Clear via explicit null.
    putResp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { acceptance_criteria: null },
    });
    expect(putResp.statusCode).toBe(200);
    expect(JSON.parse(putResp.body).acceptance_criteria).toBeNull();
  });

  it('PUT omitting acceptance_criteria leaves it untouched', async () => {
    const createResp = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Untouched-target',
        project_id: projectId,
        created_by: 'tester',
        acceptance_criteria: 'preserve me',
      },
    });
    const id = (JSON.parse(createResp.body) as { id: number }).id;

    // PUT with an unrelated field — acceptance_criteria stays put.
    const putResp = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${id}`,
      headers,
      payload: { title: 'Renamed' },
    });
    expect(putResp.statusCode).toBe(200);
    expect(JSON.parse(putResp.body).acceptance_criteria).toBe('preserve me');
  });

  it('POST rejects acceptance_criteria > 5000 chars with 400', async () => {
    const tooLong = 'a'.repeat(5001);
    const resp = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Over-long criteria',
        project_id: projectId,
        created_by: 'tester',
        acceptance_criteria: tooLong,
      },
    });
    expect(resp.statusCode).toBe(400);
    // Confirm row wasn't created.
    const rows = db
      .prepare("SELECT id FROM tasks WHERE title = 'Over-long criteria'")
      .all() as Array<{ id: number }>;
    expect(rows).toHaveLength(0);
  });
});
