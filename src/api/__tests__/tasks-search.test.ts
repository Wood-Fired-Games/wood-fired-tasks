import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { App } from '../../index.js';

// Set API key for tests (must be set before createServer())
process.env.API_KEYS = 'test-key';

describe('Task search validation (REST)', () => {
  let server: FastifyInstance;
  let app: App;
  let db: Database.Database;
  const headers = { 'x-api-key': 'test-key' };
  let testProjectId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    db = result.app.db;

    const project = app.projectService.createProject({
      name: 'Search Test Project',
    });
    testProjectId = project.id;
  });

  afterAll(async () => {
    await server.close();
    db.close();
  });

  beforeEach(() => {
    // Seed two tasks so the FTS index has rows; without rows some malformed
    // expressions short-circuit before SQLite parses MATCH.
    app.taskService.createTask({
      title: 'Fix login bug',
      description: 'auth and session',
      project_id: testProjectId,
      created_by: 'tester',
    });
    app.taskService.createTask({
      title: 'Database migration bug',
      description: 'migrate users to a new schema',
      project_id: testProjectId,
      created_by: 'tester',
    });
  });

  const MALFORMED_INPUTS: Array<{ name: string; input: string }> = [
    { name: 'bare double quote', input: '"' },
    { name: 'unterminated NEAR(', input: 'NEAR(' },
    { name: 'bare wildcard', input: '*' },
    { name: 'dangling OR operator', input: 'foo OR' },
    { name: 'unterminated phrase', input: '"unterminated phrase' },
  ];

  for (const { name, input } of MALFORMED_INPUTS) {
    it(`returns 400 (not 500) with sanitized body for ${name}`, async () => {
      const response = await server.inject({
        method: 'GET',
        url: `/api/v1/tasks?project_id=${testProjectId}&search=${encodeURIComponent(input)}`,
        headers,
      });

      expect(response.statusCode).toBe(400);
      expect(response.statusCode).not.toBe(500);

      const body = response.body;
      // No raw SQLite parser text in the response.
      expect(body).not.toContain('fts5:');
      expect(body).not.toContain('SQLITE');
      expect(body).not.toContain('unterminated string');
      expect(body).not.toContain('parse error');

      // The shape is the structured ValidationError envelope produced by
      // src/api/hooks/error-handler.ts — `details` IS the fieldErrors map.
      const parsed = response.json() as {
        error: string;
        message: string;
        details?: Record<string, string[]>;
      };
      expect(parsed.error).toBe('VALIDATION_ERROR');
      expect(parsed.message).toBe('Validation failed');
      expect(parsed.details?.search).toBeDefined();
      expect(parsed.details?.search?.length).toBeGreaterThan(0);
    });
  }

  it('rejects search with more than 32 terms before SQLite is queried', async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`).join(' ');
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${testProjectId}&search=${encodeURIComponent(tooMany)}`,
      headers,
    });

    // Fastify schema validation returns its own error envelope (400 with
    // `error: 'FST_*'`); the only invariant we care about is that it is a
    // structured 4xx without raw SQLite leakage.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.body).not.toContain('fts5:');
    expect(response.body).not.toContain('SQLITE');
  });

  it('returns 200 with matching tasks for a valid search', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${testProjectId}&search=login`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ title: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((t) => t.title === 'Fix login bug')).toBe(true);
  });

  it('returns 200 with matching tasks for a valid prefix search', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks?project_id=${testProjectId}&search=${encodeURIComponent('migr*')}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ title: string }>;
    expect(body.some((t) => t.title.includes('migration'))).toBe(true);
  });
});
