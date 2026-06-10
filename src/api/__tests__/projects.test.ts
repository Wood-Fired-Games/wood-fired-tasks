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
