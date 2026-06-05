import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';

// Configure low limits BEFORE importing server-builder
process.env.API_KEYS = 'test-key';
process.env.RATE_LIMIT_MAX = '3';
process.env.RATE_LIMIT_TIME_WINDOW = '1 minute';

/**
 * Rate limit hardening (task #182): @fastify/rate-limit returns 429 after
 * the configured threshold of requests from the same IP, except for /health
 * which is allow-listed.
 */
describe('API rate limiting', () => {
  let server: FastifyInstance;
  let db: Database.Database;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    db = result.app.db;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_TIME_WINDOW;
  });

  it('returns 429 after the 3-request threshold from the same IP', async () => {
    const headers = { 'x-api-key': 'test-key' };

    const r1 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });
    const r2 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });
    const r3 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });
    const r4 = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers });

    // First 3 succeed, 4th is throttled
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(200);
    expect(r4.statusCode).toBe(429);

    const body = JSON.parse(r4.body);
    expect(body.error).toBe('TOO_MANY_REQUESTS');
    expect(body.message).toMatch(/Rate limit exceeded/);
  });

  it('throttles repeated INVALID auth attempts to 429 (brute-force defence)', async () => {
    // After the above 4 requests, the limiter window is still open. Further
    // requests — even with wrong key — should hit 429 BEFORE reaching auth.
    // This is the brute-force defence: the limiter caps the supply of guesses
    // regardless of whether they pass auth.
    const bad = { 'x-api-key': 'this-is-not-the-right-key' };
    const r = await server.inject({ method: 'GET', url: '/api/v1/tasks', headers: bad });
    expect(r.statusCode).toBe(429);
  });

  it('does NOT rate-limit /health (allow-listed)', async () => {
    // Health is exempt — even repeated calls should always pass through to
    // the health route. We hit it more than `max` times.
    for (let i = 0; i < 10; i++) {
      const r = await server.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).not.toBe(429);
    }
  });
});
