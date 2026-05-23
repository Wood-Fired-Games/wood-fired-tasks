import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { App } from '../../../../index.js';

// Phase 31 Plan 02 — PATCH /api/v1/tasks/:id (PUT in REST) identity
// propagation tests. Specifically:
//
//   - When the body changes `assignee`, the route resolves `assignee_user_id`
//     best-effort:
//       * email shape (contains @) → findByEmail; if hit use user.id, else NULL
//       * any other free-form name → NULL (no display-name lookup helper)
//       * '' or null → NULL (assignee cleared)
//       * '@@@' or any email-shaped but invalid string → NULL (no crash)
//   - When the body does NOT include `assignee`, assignee_user_id is left
//     UNTOUCHED (existing PATCH semantics).
//   - Body-supplied assignee_user_id is IGNORED (T-31-02 spoof mitigation).

const TEST_KEY = 'test-key-update';
const TEST_LABEL = 'p31-02-update';

describe('PUT /api/v1/tasks/:id — assignee_user_id resolution', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let testProjectId: number;
  let aliceUserId: number;
  const headers = { 'x-api-key': TEST_KEY };

  beforeAll(async () => {
    process.env.API_KEYS = `${TEST_KEY}:${TEST_LABEL}`;
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    const project = app.projectService.createProject({ name: 'P31-02 update' });
    testProjectId = project.id;

    // Provision an OIDC-style user with a real email so findByEmail resolves.
    const info = db
      .prepare(
        `INSERT INTO users (display_name, email, oidc_provider, oidc_sub)
         VALUES ('Alice', 'alice@example.com', 'google', 'sub-alice')`,
      )
      .run();
    aliceUserId = Number(info.lastInsertRowid);
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.API_KEYS;
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

  function createTaskRow(title: string, opts: { assignee?: string | null; assignee_user_id?: number | null } = {}) {
    const task = app.taskService.createTask({
      title,
      project_id: testProjectId,
      created_by: 'seed',
      ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
    });
    if (opts.assignee_user_id !== undefined) {
      db.prepare('UPDATE tasks SET assignee_user_id = ? WHERE id = ?').run(
        opts.assignee_user_id,
        task.id,
      );
    }
    return task;
  }

  it('resolves assignee email to assignee_user_id via findByEmail', async () => {
    const task = createTaskRow('email assignee');
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: { assignee: 'alice@example.com' },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    expect(row.assignee).toBe('alice@example.com');
    expect(row.assignee_user_id).toBe(aliceUserId);
  });

  it('leaves assignee_user_id NULL when assignee is a free-form non-email string', async () => {
    const task = createTaskRow('free-form assignee');
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: { assignee: 'Some Free Form Name' },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    expect(row.assignee).toBe('Some Free Form Name');
    expect(row.assignee_user_id).toBeNull();
  });

  it('clears assignee_user_id when assignee is set to null', async () => {
    // Seed with a populated assignee + FK, then clear via PATCH.
    const task = createTaskRow('clear via null', {
      assignee: 'somebody',
      assignee_user_id: aliceUserId,
    });
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: { assignee: null },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    expect(row.assignee).toBeNull();
    expect(row.assignee_user_id).toBeNull();
  });

  it('leaves assignee_user_id UNCHANGED when body does not include assignee', async () => {
    // Pre-seed FK row so we can verify it survives a status-only PATCH.
    const task = createTaskRow('unchanged when absent', {
      assignee: 'somebody',
      assignee_user_id: aliceUserId,
    });
    const before = getTaskRow(task.id);
    expect(before.assignee_user_id).toBe(aliceUserId);

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: { status: 'in_progress' },
    });

    expect(response.statusCode).toBe(200);
    const after = getTaskRow(task.id);
    // Untouched.
    expect(after.assignee_user_id).toBe(aliceUserId);
    expect(after.assignee).toBe('somebody');
  });

  it('does not crash on email-shaped but invalid assignee (no findByEmail throw)', async () => {
    const task = createTaskRow('bad email shape');
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: { assignee: '@@@' },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    expect(row.assignee).toBe('@@@');
    expect(row.assignee_user_id).toBeNull();
  });

  it('IGNORES body-supplied assignee_user_id (T-31-02 spoof attempt)', async () => {
    const task = createTaskRow('spoof attempt');
    const SPOOFED = 99999;
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: {
        assignee: 'alice@example.com',
        assignee_user_id: SPOOFED,
      },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    // Resolution from `assignee` wins; spoof must NOT survive.
    expect(row.assignee_user_id).toBe(aliceUserId);
    expect(row.assignee_user_id).not.toBe(SPOOFED);
  });

  it('IGNORES body-supplied assignee_user_id when assignee is also a free-form string', async () => {
    // Confirms the spoofed FK doesn't accidentally land via the assignee=
    // unresolved branch (which writes NULL).
    const task = createTaskRow('spoof + free-form');
    const SPOOFED = 99998;
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: {
        assignee: 'Random Name',
        assignee_user_id: SPOOFED,
      },
    });

    expect(response.statusCode).toBe(200);
    const row = getTaskRow(task.id);
    expect(row.assignee).toBe('Random Name');
    expect(row.assignee_user_id).toBeNull();
    expect(row.assignee_user_id).not.toBe(SPOOFED);
  });
});
