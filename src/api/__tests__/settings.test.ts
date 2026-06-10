import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { authHeaders } from './helpers/auth.js';

/**
 * Configurable Task Models (Task 13) — GET|PUT /api/v1/settings/model-policy.
 *
 * The database-wide model-policy default. GET returns the stored policy (or
 * `null` when unset); PUT validates the body via `ModelPolicyNullableSchema`
 * (invalid → 400) then persists it, echoing it back.
 */
describe('GET|PUT /api/v1/settings/model-policy', () => {
  let server: FastifyInstance;
  let db: Database.Database;
  let headers: { Authorization: string };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
    headers = authHeaders(db);
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('GET returns null when no default is configured', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/model-policy',
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toBeNull();
  });

  it('PUT a valid policy → 200, and GET returns it', async () => {
    const policy = {
      execution: {
        byCategory: { minimal: 'claude-haiku-4-5', maximum: 'claude-opus-4-8' },
        default: 'auto',
      },
      validation: { constant: 'claude-sonnet-4-6' },
    };

    const putResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/model-policy',
      headers,
      payload: policy,
    });
    expect(putResponse.statusCode).toBe(200);
    expect(JSON.parse(putResponse.body)).toEqual(policy);

    const getResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/model-policy',
      headers,
    });
    expect(getResponse.statusCode).toBe(200);
    expect(JSON.parse(getResponse.body)).toEqual(policy);
  });

  it('PUT null clears the default', async () => {
    const putResponse = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/model-policy',
      headers,
      payload: null,
    });
    expect(putResponse.statusCode).toBe(200);
    expect(JSON.parse(putResponse.body)).toBeNull();

    const getResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/model-policy',
      headers,
    });
    expect(JSON.parse(getResponse.body)).toBeNull();
  });

  it('PUT an invalid policy → 400 (unknown role key)', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/model-policy',
      headers,
      payload: { orchestrator: { constant: 'claude-opus-4-8' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PUT an invalid policy → 400 (unknown category key)', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/model-policy',
      headers,
      payload: { execution: { byCategory: { gigantic: 'claude-opus-4-8' } } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/settings/model-policy',
    });
    expect(response.statusCode).toBe(401);
  });
});
