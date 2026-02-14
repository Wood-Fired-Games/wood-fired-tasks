import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';

// Set API key for tests
process.env.API_KEYS = 'test-key';

describe('POST /api/v1/tasks/:id/claim', () => {
  let server: FastifyInstance;
  let app: App;
  const headers = { 'x-api-key': 'test-key', 'content-type': 'application/json' };
  let testProjectId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    // Create a test project
    const project = app.projectService.createProject({ name: 'Claim Test Project' });
    testProjectId = project.id;
  });

  afterAll(async () => {
    await server.close();
    app.db.close();
  });

  /**
   * Helper to create a fresh open task for each test
   */
  function createOpenTask(title?: string) {
    return app.taskService.createTask({
      title: title || 'Claimable Task',
      project_id: testProjectId,
      created_by: 'test-user',
    });
  }

  it('returns 200 with claimed task when claiming open task', async () => {
    const task = createOpenTask('Claim Me');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.assignee).toBe('agent-1');
    expect(body.status).toBe('in_progress');
    expect(body.claimed_at).toBeTruthy();
    expect(body.version).toBe(2);
  });

  it('returns 409 Conflict when claiming already-claimed task', async () => {
    const task = createOpenTask('Already Claimed');

    // First claim succeeds
    await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-1' },
    });

    // Second claim should fail
    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-2' },
    });

    expect(response.statusCode).toBe(409);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('CONFLICT');
    expect(body.message).toContain('cannot be claimed');
  });

  it('returns 404 for non-existent task', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/tasks/99999/claim',
      headers,
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 when missing assignee in body', async () => {
    const task = createOpenTask('No Assignee');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: {},
    });

    // Zod schema validation should catch missing required field
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when assignee is empty string', async () => {
    const task = createOpenTask('Empty Assignee');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns cached 200 response for duplicate X-Idempotency-Key', async () => {
    const task = createOpenTask('Idempotent Claim');
    const idempotencyKey = 'idem-key-123';

    // First request
    const first = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': idempotencyKey },
      payload: { assignee: 'agent-1' },
    });

    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);

    // Second request with same idempotency key
    const second = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': idempotencyKey },
      payload: { assignee: 'agent-1' },
    });

    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);

    // Responses should be identical (cached)
    expect(secondBody).toEqual(firstBody);
  });

  it('accepts X-Claim-Source: workflow header', async () => {
    const task = createOpenTask('Workflow Claim');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { ...headers, 'x-claim-source': 'workflow' },
      payload: { assignee: 'workflow-agent' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.assignee).toBe('workflow-agent');
    expect(body.status).toBe('in_progress');
  });

  it('exactly one of 20 concurrent claims succeeds with 200, rest get 409', async () => {
    const task = createOpenTask('20-Agent Race');

    // Fire 20 concurrent claim requests
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        server.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/claim`,
          headers,
          payload: { assignee: `agent-${i}` },
        })
      )
    );

    const successes = results.filter((r) => r.statusCode === 200);
    const conflicts = results.filter((r) => r.statusCode === 409);

    // Exactly one wins, nineteen lose
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(19);

    // No SQLITE_BUSY or 500 errors
    const errors = results.filter((r) => r.statusCode >= 500);
    expect(errors).toHaveLength(0);

    // Winner has correct state
    const winner = JSON.parse(successes[0].body);
    expect(winner.status).toBe('in_progress');
    expect(winner.assignee).toBeTruthy();
    expect(winner.claimed_at).toBeTruthy();
  });

  it('returns 401 without X-API-Key header', async () => {
    const task = createOpenTask('Auth Required');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { 'content-type': 'application/json' },
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(401);
  });
});
