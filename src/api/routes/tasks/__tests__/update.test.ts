import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';
import { authHeaders } from '../../../__tests__/helpers/auth.js';

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

describe('PUT /api/v1/tasks/:id — assignee_user_id resolution', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let testProjectId: number;
  let aliceUserId: number;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    headers = authHeaders(app.db);
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
  });

  function getTaskRow(id: number): {
    id: number;
    assignee: string | null;
    assignee_user_id: number | null;
  } {
    return db.prepare('SELECT id, assignee, assignee_user_id FROM tasks WHERE id = ?').get(id) as {
      id: number;
      assignee: string | null;
      assignee_user_id: number | null;
    };
  }

  function createTaskRow(
    title: string,
    opts: { assignee?: string | null; assignee_user_id?: number | null } = {},
  ) {
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

  it('REJECTS body-supplied assignee_user_id with 400 (WR-04: strict client schema)', async () => {
    // Phase 31 review WR-04: the route's PUT body schema
    // (`UpdateTaskClientSchema`) omits server-derived `assignee_user_id`
    // and uses `.strict()` — clients supplying it now get a 400 instead
    // of having the value silently stripped + overridden.
    const task = createTaskRow('spoof attempt');
    const ORIGINAL_FK: number | null = null;
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

    expect(response.statusCode).toBe(400);
    const row = getTaskRow(task.id);
    // No update happened — FK stays at its pre-request value.
    expect(row.assignee_user_id).toBe(ORIGINAL_FK);
    expect(row.assignee_user_id).not.toBe(SPOOFED);
  });

  it('REJECTS body-supplied assignee_user_id when assignee is also a free-form string (WR-04)', async () => {
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

    expect(response.statusCode).toBe(400);
    const row = getTaskRow(task.id);
    // No update happened — assignee TEXT stays unchanged and FK stays null.
    expect(row.assignee).toBeNull();
    expect(row.assignee_user_id).toBeNull();
    expect(row.assignee_user_id).not.toBe(SPOOFED);
  });

  // WR-01 + WR-04: defense-in-depth meets strict client schema. The PUT
  // body schema doesn't declare `created_by_user_id` and is .strict(), so
  // any client supplying that key gets a 400. The route's destructure
  // pattern is still in place as a belt-and-suspenders against future
  // schema drift.
  it('REJECTS body-supplied created_by_user_id with 400 (WR-01 + WR-04)', async () => {
    // Seed an existing FK so we can verify the spoof attempt didn't survive.
    const task = createTaskRow('spoof created_by_user_id');
    const ORIGINAL_CREATOR = aliceUserId;
    db.prepare('UPDATE tasks SET created_by_user_id = ? WHERE id = ?').run(
      ORIGINAL_CREATOR,
      task.id,
    );

    const SPOOFED = 99997;
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${task.id}`,
      headers,
      payload: {
        title: 'updated-title',
        created_by_user_id: SPOOFED,
      },
    });

    expect(response.statusCode).toBe(400);
    const row = db.prepare('SELECT created_by_user_id FROM tasks WHERE id = ?').get(task.id) as {
      created_by_user_id: number | null;
    };
    // The original creator FK is preserved; the spoof MUST NOT have
    // overwritten it.
    expect(row.created_by_user_id).toBe(ORIGINAL_CREATOR);
    expect(row.created_by_user_id).not.toBe(SPOOFED);
  });
});
