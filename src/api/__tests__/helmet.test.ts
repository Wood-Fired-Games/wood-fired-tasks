import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import type { App } from '../../index.js';

// Set API key for tests (same harness convention as tasks.test.ts).
process.env.API_KEYS = 'test-key';

describe('Task #383: @fastify/helmet security headers on the JSON API surface', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  const headers = { 'x-api-key': 'test-key' };

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  it('stamps x-content-type-options: nosniff on a JSON API route', async () => {
    // /api/v1/projects is a JSON API route guarded by the auth plugin.
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('stamps x-frame-options on a JSON API route', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers,
    });

    // helmet default is SAMEORIGIN.
    expect(response.headers['x-frame-options']).toBeDefined();
    expect(String(response.headers['x-frame-options']).toUpperCase()).toContain(
      'SAMEORIGIN',
    );
  });

  it('does NOT emit a global Content-Security-Policy on JSON API responses (CSP is left to the HTML routes)', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers,
    });

    // contentSecurityPolicy is disabled in the helmet registration so the
    // server-rendered HTML routes remain the single source of truth for CSP.
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('also stamps nosniff on an unauthenticated JSON response (helmet is top-level)', async () => {
    // No api key → auth plugin returns a JSON 401, but helmet's onRequest
    // hook runs first so the security header is still present.
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
