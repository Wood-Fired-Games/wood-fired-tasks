import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

// Set API keys before importing server
process.env.API_KEYS = 'test-key';

describe('API Authentication', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    // Ensure API keys are set before server creation
    process.env.API_KEYS = 'test-key';
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('should reject requests without X-API-Key header with 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    const body = JSON.parse(response.body);
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.message).toContain('Missing API key');
  });

  it('should reject requests with invalid X-API-Key with 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-api-key': 'invalid-key',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    const body = JSON.parse(response.body);
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.message).toContain('Invalid API key');
  });

  it('should accept requests with valid test-key', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: {
        'x-api-key': 'test-key',
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('should reject POST requests without API key with 401', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        title: 'Test Task',
        project_id: 1,
        created_by: 'test',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
  });
});
