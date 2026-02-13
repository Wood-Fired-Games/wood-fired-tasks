import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

// Set API key for tests
process.env.API_KEYS = 'test-key';

describe('Project CRUD Routes', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  const headers = { 'x-api-key': 'test-key' };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
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

  it('should list all projects with GET /projects', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
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
