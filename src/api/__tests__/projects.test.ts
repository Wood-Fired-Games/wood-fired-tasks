import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { authHeaders } from './helpers/auth.js';

describe('Project CRUD Routes', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    headers = authHeaders(db);
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('should create a project and return 201', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: {
        name: 'Test Project',
        description: 'Test description',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.id).toBeDefined();
    expect(body.name).toBe('Test Project');
    expect(body.description).toBe('Test description');
    expect(body.created_at).toBeDefined();
  });

  it('should list all projects with GET /projects (envelope)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ limit: 50, offset: 0 });
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('paginates projects with custom limit/offset', async () => {
    // Seed extra projects so we have a window to paginate over.
    for (let i = 0; i < 5; i++) {
      await server.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers,
        payload: { name: `Pagination Project ${i + 1}` },
      });
    }

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=2&offset=1',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('rejects limit > 500 with 400', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=501',
      headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects negative offset with 400', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects?offset=-1',
      headers,
    });
    expect(response.statusCode).toBe(400);
  });

  it('should get a single project by ID', async () => {
    // Create a project first
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: {
        name: 'Get Test Project',
      },
    });
    const created = JSON.parse(createResponse.body);

    // Get the project
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.id}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe(created.id);
    expect(body.name).toBe('Get Test Project');
  });

  it('should update a project and return 200', async () => {
    // Create a project first
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: {
        name: 'Update Test Project',
      },
    });
    const created = JSON.parse(createResponse.body);

    // Update the project
    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${created.id}`,
      headers,
      payload: {
        name: 'Updated Project Name',
        description: 'Updated description',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.name).toBe('Updated Project Name');
    expect(body.description).toBe('Updated description');
  });

  it('PUT /projects/:id with model_policy persists; GET returns it', async () => {
    // Create a project first.
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name: 'Model Policy Project' },
    });
    const created = JSON.parse(createResponse.body);

    const model_policy = {
      execution: { default: 'auto', byCategory: { maximum: 'claude-opus-4-8' } },
      validation: { constant: 'claude-sonnet-4-6' },
    };

    // PUT the policy.
    const updateResponse = await server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${created.id}`,
      headers,
      payload: { model_policy },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(JSON.parse(updateResponse.body).model_policy).toEqual(model_policy);

    // GET round-trips the persisted policy.
    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.id}`,
      headers,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(JSON.parse(getResponse.body).model_policy).toEqual(model_policy);
  });

  it('POST /projects with model_policy persists it', async () => {
    const model_policy = { planning: { constant: 'claude-opus-4-8' } };
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name: 'Create With Policy', model_policy },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.body);
    expect(created.model_policy).toEqual(model_policy);

    const getResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${created.id}`,
      headers,
    });
    expect(JSON.parse(getResponse.body).model_policy).toEqual(model_policy);
  });

  it('PUT /projects/:id with an invalid model_policy → 400', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name: 'Invalid Policy Project' },
    });
    const created = JSON.parse(createResponse.body);

    const response = await server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${created.id}`,
      headers,
      // Unknown role key — rejected by ModelPolicySchema's `.strict()`.
      payload: { model_policy: { orchestrator: { constant: 'claude-opus-4-8' } } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('should delete a project and return 204', async () => {
    // Create a project first
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: {
        name: 'Delete Test Project',
      },
    });
    const created = JSON.parse(createResponse.body);

    // Delete the project
    const response = await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${created.id}`,
      headers,
    });

    expect(response.statusCode).toBe(204);
  });
});

/**
 * Archived project state (docs/design/project-archived-state.md §2.2, §2.5,
 * §2.6): POST /:id/archive, POST /:id/unarchive and the `archived` list filter.
 */
describe('Project archive routes', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
    headers = authHeaders(db, { displayName: 'archiver-alice' });
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  async function createProject(name: string): Promise<number> {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers,
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id;
  }

  async function createTask(projectId: number): Promise<number> {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers,
      payload: { title: 'unfinished', project_id: projectId, created_by: 'test-user' },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body).id;
  }

  function post(url: string, payload?: unknown, h = headers) {
    return server.inject({
      method: 'POST',
      url,
      headers: h,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  }

  it('POST /:id/archive returns 200 and the archived project; archived_by is the caller', async () => {
    const id = await createProject('archive-200');
    const res = await post(`/api/v1/projects/${id}/archive`, { reason: '  shipped  ' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(id);
    expect(body.archived).toBe(true);
    expect(body.archived_at).toEqual(expect.any(String));
    expect(body.archived_by).toBe('archiver-alice');
    expect(body.archive_reason).toBe('shipped');
  });

  it('archive works with no body at all', async () => {
    const id = await createProject('archive-no-body');
    const res = await post(`/api/v1/projects/${id}/archive`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).archived).toBe(true);
  });

  it('archived_by cannot be supplied in the body', async () => {
    const id = await createProject('archive-spoof');
    const res = await post(`/api/v1/projects/${id}/archive`, { archived_by: 'mallory' });
    // Whether the unknown key is rejected or dropped, it never becomes the actor.
    if (res.statusCode === 200) {
      expect(JSON.parse(res.body).archived_by).toBe('archiver-alice');
    } else {
      expect(res.statusCode).toBe(400);
      const get = await server.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers });
      expect(JSON.parse(get.body).archived).toBe(false);
    }
  });

  it('archive of an already archived project returns it unchanged', async () => {
    const id = await createProject('archive-twice');
    const first = JSON.parse(
      (await post(`/api/v1/projects/${id}/archive`, { reason: 'one' })).body,
    );
    const again = await post(`/api/v1/projects/${id}/archive`, { reason: 'two' });
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toEqual(first);
  });

  it('archive returns 404 for a project that does not exist', async () => {
    const res = await post('/api/v1/projects/999999/archive', {});
    expect(res.statusCode).toBe(404);
  });

  it('archive returns 422 with per-status counts while tasks are unfinished', async () => {
    const id = await createProject('archive-422');
    await createTask(id);
    const res = await post(`/api/v1/projects/${id}/archive`, {});

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
    expect(body.message).toMatch(/^project_has_unfinished_tasks/);
    expect(body.message).toContain('open: 1');
    // WFT #2530: the counts are structured, not only message text.
    expect(body.details).toEqual({
      code: 'project_has_unfinished_tasks',
      total: 1,
      counts: { open: 1, in_progress: 0, blocked: 0, backlogged: 0 },
    });
    const get = await server.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers });
    expect(JSON.parse(get.body).archived).toBe(false);
  });

  it('declares every response the archive and unarchive routes give (WFT #2530)', () => {
    const spec = server.swagger() as {
      paths: Record<string, { post?: { responses?: Record<string, unknown> } }>;
    };
    const responsesOf = (suffix: string): string[] => {
      const path = Object.keys(spec.paths).find((p) => p.endsWith(suffix));
      expect(path).toBeDefined();
      return Object.keys(spec.paths[path as string].post?.responses ?? {}).sort();
    };
    expect(responsesOf('/projects/{id}/archive')).toEqual(['200', '400', '404', '422']);
    expect(responsesOf('/projects/{id}/unarchive')).toEqual(['200', '400', '404']);
  });

  it('force with a reason archives despite unfinished tasks; force without a reason is 400', async () => {
    const id = await createProject('archive-force');
    await createTask(id);

    const noReason = await post(`/api/v1/projects/${id}/archive`, { force: true });
    expect(noReason.statusCode).toBe(400);
    // WFT #2530: a stable code a client can anchor on.
    expect(JSON.parse(noReason.body).message).toContain(
      'archive_reason_required: reason is required when force is true',
    );

    const forced = await post(`/api/v1/projects/${id}/archive`, { force: true, reason: 'shelved' });
    expect(forced.statusCode).toBe(200);
    expect(JSON.parse(forced.body).archived).toBe(true);
  });

  it('a write on an archived project is 422 project_archived', async () => {
    const id = await createProject('archive-frozen');
    await post(`/api/v1/projects/${id}/archive`, {});
    const res = await server.inject({
      method: 'PUT',
      url: `/api/v1/projects/${id}`,
      headers,
      payload: { description: 'nope' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).message).toMatch(/^project_archived/);
  });

  it('POST /:id/unarchive returns 200 and the project, and is a no-op when not archived', async () => {
    const id = await createProject('unarchive-200');
    await post(`/api/v1/projects/${id}/archive`, { reason: 'x' });

    const res = await post(`/api/v1/projects/${id}/unarchive`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(id);
    expect(body.archived).toBe(false);
    expect(body.archived_at).toBeNull();
    expect(body.archived_by).toBeNull();
    expect(body.archive_reason).toBeNull();

    const again = await post(`/api/v1/projects/${id}/unarchive`);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).archived).toBe(false);
  });

  it('unarchive returns 404 for a project that does not exist', async () => {
    const res = await post('/api/v1/projects/999999/unarchive');
    expect(res.statusCode).toBe(404);
  });

  it('both routes need the write scope: a read token gets 403', async () => {
    const id = await createProject('archive-scope');
    const readOnly = authHeaders(db, { displayName: 'reader', scopes: ['read'] });

    const archive = await post(`/api/v1/projects/${id}/archive`, {}, readOnly);
    expect(archive.statusCode).toBe(403);
    const unarchive = await post(`/api/v1/projects/${id}/unarchive`, undefined, readOnly);
    expect(unarchive.statusCode).toBe(403);

    const get = await server.inject({ method: 'GET', url: `/api/v1/projects/${id}`, headers });
    expect(JSON.parse(get.body).archived).toBe(false);
  });

  it('both routes need authentication', async () => {
    const id = await createProject('archive-anon');
    const archive = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${id}/archive`,
      payload: {},
    });
    expect(archive.statusCode).toBe(401);
    const unarchive = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${id}/unarchive`,
    });
    expect(unarchive.statusCode).toBe(401);
  });

  describe('GET /projects archived filter', () => {
    let listServer: FastifyInstance;
    let listDb: Database.Database;
    let h: { Authorization: string };
    let liveId: number;
    let archivedId: number;

    beforeAll(async () => {
      const result = await createServer({ dbPath: ':memory:' });
      listServer = result.server;
      listDb = result.app.db;
      h = authHeaders(listDb);
      liveId = result.app.projectService.createProject({ name: 'live' }).id;
      archivedId = result.app.projectService.createProject({ name: 'archived' }).id;
      result.app.projectService.archiveProject(archivedId, {}, 'tester');
    });

    afterAll(async () => {
      await listServer.close();
      listDb.close();
    });

    async function list(query: string) {
      const res = await listServer.inject({
        method: 'GET',
        url: `/api/v1/projects${query}`,
        headers: h,
      });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    }

    it('omits archived projects by default, and total counts the filtered set', async () => {
      const { status, body } = await list('');
      expect(status).toBe(200);
      expect(body.data.map((p: { id: number }) => p.id)).toEqual([liveId]);
      expect(body.total).toBe(1);
    });

    it('archived=exclude is the default spelled out', async () => {
      const { body } = await list('?archived=exclude');
      expect(body.data.map((p: { id: number }) => p.id)).toEqual([liveId]);
      expect(body.total).toBe(1);
    });

    it('archived=include returns both, total 2', async () => {
      const { body } = await list('?archived=include');
      expect(body.data.map((p: { id: number }) => p.id).sort()).toEqual(
        [liveId, archivedId].sort(),
      );
      expect(body.total).toBe(2);
    });

    it('archived=only returns only the archived project, total 1', async () => {
      const { body } = await list('?archived=only');
      expect(body.data.map((p: { id: number }) => p.id)).toEqual([archivedId]);
      expect(body.total).toBe(1);
      expect(body.data[0].archived).toBe(true);
    });

    it('total stays the filtered count when the page is smaller', async () => {
      const { body } = await list('?archived=include&limit=1');
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(2);
    });

    it('rejects an unknown archived value with 400', async () => {
      const { status } = await list('?archived=sometimes');
      expect(status).toBe(400);
    });

    it('GET /:id still returns an archived project', async () => {
      const res = await listServer.inject({
        method: 'GET',
        url: `/api/v1/projects/${archivedId}`,
        headers: h,
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).archived).toBe(true);
    });
  });
});
