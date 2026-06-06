import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../../../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../../../db/driver.js';
import type { App } from '../../../../index.js';
import { seedAuth } from '../../../__tests__/helpers/auth.js';

// Phase 31 Plan 02 — POST /api/v1/tasks identity propagation tests.
//
// What this file covers (additive to src/api/__tests__/tasks.test.ts):
//
//   1. T-31-02 mitigation: body-supplied `*_user_id` fields MUST be stripped
//      server-side. A client supplying `created_by_user_id: 999` does NOT end
//      up with that value in the DB — the row gets `created_by_user_id =
//      request.user.id` instead.
//   2. Positive: every authenticated create populates `created_by_user_id`
//      from `request.user.id`.

describe('POST /api/v1/tasks — identity FK injection', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  let testProjectId: number;
  let legacyUserId: number;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
    // v2.0 auth cutover (#799/#801/#802): X-API-Key + legacy seeding are gone.
    // Seed a real principal directly and authenticate via its Bearer PAT; the
    // FK-injection contract asserts created_by_user_id resolves to this user.
    const seeded = seedAuth(db);
    legacyUserId = seeded.userId;
    headers = seeded.headers;
    const project = app.projectService.createProject({ name: 'P31-02 create' });
    testProjectId = project.id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  function getTaskRow(id: number): {
    id: number;
    created_by: string;
    created_by_user_id: number | null;
    assignee_user_id: number | null;
  } {
    const row = db
      .prepare(
        'SELECT id, created_by, created_by_user_id, assignee_user_id FROM tasks WHERE id = ?',
      )
      .get(id) as {
      id: number;
      created_by: string;
      created_by_user_id: number | null;
      assignee_user_id: number | null;
    };
    return row;
  }

  it('populates created_by_user_id from request.user.id on legacy-key create', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Identity create test',
        project_id: testProjectId,
        created_by: 'free-form-text',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    const row = getTaskRow(body.id);
    // Legacy TEXT column populated as today.
    expect(row.created_by).toBe('free-form-text');
    // NEW: FK column populated from request.user.id (legacy seeded user).
    expect(row.created_by_user_id).toBe(legacyUserId);
  });

  it('REJECTS body-supplied created_by_user_id with 400 (WR-04: strict client schema)', async () => {
    // Phase 31 review WR-04 hardening: the route's body schema
    // (`CreateTaskClientSchema`) omits server-derived FK fields and uses
    // `.strict()`, so a client supplying `created_by_user_id` now gets a
    // 400 validation error instead of having the value silently stripped.
    // Failing loud is the documented spoof barrier.
    const SPOOFED = 99999;
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Spoof create_by_user_id',
        project_id: testProjectId,
        created_by: 'alice',
        created_by_user_id: SPOOFED,
      },
    });

    expect(response.statusCode).toBe(400);
    // Confirm the spoofed value never landed in the DB (i.e. the row was
    // never created).
    const allRows = db
      .prepare('SELECT id, created_by_user_id FROM tasks WHERE created_by_user_id = ?')
      .all(SPOOFED) as Array<{ id: number; created_by_user_id: number | null }>;
    expect(allRows).toHaveLength(0);
  });

  it('REJECTS body-supplied assignee_user_id on create with 400 (WR-04)', async () => {
    const SPOOFED = 88888;
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Spoof assignee_user_id on create',
        project_id: testProjectId,
        created_by: 'alice',
        assignee: 'someone',
        assignee_user_id: SPOOFED,
      },
    });

    expect(response.statusCode).toBe(400);
    const allRows = db
      .prepare('SELECT id, assignee_user_id FROM tasks WHERE assignee_user_id = ?')
      .all(SPOOFED) as Array<{ id: number; assignee_user_id: number | null }>;
    expect(allRows).toHaveLength(0);
  });

  it('legacy-key auth maps to the seeded legacy user (sanity check)', async () => {
    // This is a positive control: confirms the legacyUserId we read at setup
    // matches what request.user.id resolves to inside the auth chain.
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: {
        title: 'Sanity row',
        project_id: testProjectId,
        created_by: 'whoever',
      },
    });
    expect(response.statusCode).toBe(201);
    const row = getTaskRow(JSON.parse(response.body).id);
    expect(row.created_by_user_id).toBe(legacyUserId);
  });
});
