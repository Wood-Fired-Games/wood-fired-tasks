import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server.js';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../index.js';
import { authHeaders } from './helpers/auth.js';

describe('POST /api/v1/tasks/:id/claim', () => {
  let server: FastifyInstance;
  let app: App;
  let headers: { Authorization: string; 'content-type': string };
  let testProjectId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    await server.ready();

    // v2.0: authenticate via a seeded PAT (X-API-Key was removed in #799/#802)
    headers = { ...authHeaders(app.db), 'content-type': 'application/json' };

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

  describe('archived project', () => {
    it('returns 422 BUSINESS_RULE_VIOLATION with the project_archived prefix, not 409', async () => {
      const project = app.projectService.createProject({ name: 'Claim Archived Project' });
      const task = app.taskService.createTask({
        title: 'Frozen',
        project_id: project.id,
        created_by: 'test-user',
      });
      app.projectService.archiveProject(project.id, { force: true, reason: 'shelved' }, 'tester');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/claim`,
        headers,
        payload: { assignee: 'agent-1' },
      });

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
      expect(body.message).toMatch(/^project_archived/);
      // Nothing was claimed.
      const after = app.taskService.getTask(task.id);
      expect(after.assignee).toBeNull();
      expect(after.status).toBe('open');
    });

    it('a repeated claim with a cached idempotency key answers 422 once the project is archived, and replays again after unarchive (WFT #2523)', async () => {
      const project = app.projectService.createProject({ name: 'Claim Replay Archived Project' });
      const task = app.taskService.createTask({
        title: 'Claimed, then frozen',
        project_id: project.id,
        created_by: 'test-user',
      });
      const claim = () =>
        server.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/claim`,
          headers: { ...headers, 'x-idempotency-key': 'replay-archived-key' },
          payload: { assignee: 'agent-1' },
        });

      const first = await claim();
      expect(first.statusCode).toBe(200);
      app.projectService.archiveProject(project.id, { force: true, reason: 'shelved' }, 'tester');
      const frozen = app.taskService.getTask(task.id);

      const repeated = await claim();

      expect(repeated.statusCode).toBe(422);
      const body = JSON.parse(repeated.body);
      expect(body.error).toBe('BUSINESS_RULE_VIOLATION');
      expect(body.message).toMatch(/^project_archived/);
      // The refusal wrote nothing.
      expect(app.taskService.getTask(task.id)).toEqual(frozen);

      // The cached success is still the right answer once the freeze is lifted.
      app.projectService.unarchiveProject(project.id, 'tester');
      const afterUnarchive = await claim();
      expect(afterUnarchive.statusCode).toBe(200);
      expect(JSON.parse(afterUnarchive.body)).toEqual(JSON.parse(first.body));
    });

    it('a cached idempotency key for a task deleted since still replays its 200', async () => {
      // The archive check on a replay must not turn a missing task into a 404.
      const task = createOpenTask('Claimed, then deleted');
      const claim = () =>
        server.inject({
          method: 'POST',
          url: `/api/v1/tasks/${task.id}/claim`,
          headers: { ...headers, 'x-idempotency-key': 'replay-deleted-key' },
          payload: { assignee: 'agent-1' },
        });
      const first = await claim();
      expect(first.statusCode).toBe(200);
      app.taskService.deleteTask(task.id);

      const repeated = await claim();

      expect(repeated.statusCode).toBe(200);
      expect(JSON.parse(repeated.body)).toEqual(JSON.parse(first.body));
    });

    it('declares 422 on the claim route in the OpenAPI document', async () => {
      const spec = server.swagger() as {
        paths: Record<string, { post?: { responses?: Record<string, unknown> } }>;
      };
      const claimPath = Object.keys(spec.paths).find((path) => path.endsWith('/tasks/{id}/claim'));
      expect(claimPath).toBeDefined();
      expect(Object.keys(spec.paths[claimPath as string].post?.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '400', '409', '422']),
      );
    });

    it('a genuine claim conflict in an unarchived project is still 409 CONFLICT', async () => {
      const task = createOpenTask('Conflict stays 409');
      app.taskService.claimTask(task.id, 'agent-1');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/claim`,
        headers,
        payload: { assignee: 'agent-2' },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('CONFLICT');
      expect(body.message).not.toMatch(/^project_archived/);
    });

    it('an already-claimed task in an archived project answers 422, the freeze wins over the conflict', async () => {
      const project = app.projectService.createProject({ name: 'Claim Archived Held Project' });
      const task = app.taskService.createTask({
        title: 'Held then frozen',
        project_id: project.id,
        created_by: 'test-user',
      });
      app.taskService.claimTask(task.id, 'agent-1');
      app.projectService.archiveProject(project.id, { force: true, reason: 'shelved' }, 'tester');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/claim`,
        headers,
        payload: { assignee: 'agent-2' },
      });

      expect(response.statusCode).toBe(422);
      expect(JSON.parse(response.body).message).toMatch(/^project_archived/);
    });

    it('claim answers 200 again after unarchive', async () => {
      const project = app.projectService.createProject({ name: 'Claim Unarchived Project' });
      const task = app.taskService.createTask({
        title: 'Thawed',
        project_id: project.id,
        created_by: 'test-user',
      });
      app.projectService.archiveProject(project.id, { force: true, reason: 'shelved' }, 'tester');
      app.projectService.unarchiveProject(project.id, 'tester');

      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/claim`,
        headers,
        payload: { assignee: 'agent-1' },
      });

      expect(response.statusCode).toBe(200);
    });
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

  it('rejects X-Idempotency-Key shorter than 8 chars with 400', async () => {
    const task = createOpenTask('Short Idem Key');

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': 'short' },
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects X-Idempotency-Key longer than 128 chars with 400', async () => {
    const task = createOpenTask('Long Idem Key');
    const longKey = 'a'.repeat(129);

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': longKey },
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('rejects X-Idempotency-Key with disallowed characters with 400', async () => {
    const task = createOpenTask('Bad Charset Idem Key');

    for (const badKey of [
      'has spaces in it',
      'has;semicolon-12345',
      'has"quote-12345',
      'has/slash-12345',
      "has'apostrophe1",
      'has.period.1234',
    ]) {
      const response = await server.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/claim`,
        headers: { ...headers, 'x-idempotency-key': badKey },
        payload: { assignee: 'agent-1' },
      });

      expect(response.statusCode, `expected 400 for key="${badKey}"`).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts valid X-Idempotency-Key (UUID-like, 36 chars) with 200', async () => {
    const task = createOpenTask('Valid Idem Key UUID');
    const validKey = '550e8400-e29b-41d4-a716-446655440000';

    const response = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': validKey },
      payload: { assignee: 'agent-1' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.assignee).toBe('agent-1');
  });

  it('accepts X-Idempotency-Key at exact boundaries (8 and 128 chars)', async () => {
    const taskMin = createOpenTask('Boundary Min');
    const minKey = 'a'.repeat(8);
    const minResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskMin.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': minKey },
      payload: { assignee: 'agent-min' },
    });
    expect(minResponse.statusCode).toBe(200);

    const taskMax = createOpenTask('Boundary Max');
    const maxKey = 'b'.repeat(128);
    const maxResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskMax.id}/claim`,
      headers: { ...headers, 'x-idempotency-key': maxKey },
      payload: { assignee: 'agent-max' },
    });
    expect(maxResponse.statusCode).toBe(200);
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
        }),
      ),
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

  // Task #1003: same-assignee re-claim over REST is a renewal (200), not a 409.
  it('returns 200 (renewal) when the SAME assignee re-claims a task they hold', async () => {
    const task = createOpenTask('Renewable Task');

    const first = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-1' },
    });
    expect(first.statusCode).toBe(200);

    const renewal = await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-1' },
    });

    expect(renewal.statusCode).toBe(200);
    const body = JSON.parse(renewal.body);
    expect(body.assignee).toBe('agent-1');
    expect(body.status).toBe('in_progress');
    expect(body.version).toBe(JSON.parse(first.body).version + 1);
  });

  // Task #1003: GET /tasks/:id surfaces the claim TTL + remaining seconds
  // (proves the additive optional fields survive the response schema).
  it('GET /tasks/:id surfaces claim_ttl_minutes and claim_remaining_seconds while claimed', async () => {
    const task = createOpenTask('TTL Visible Over REST');

    await server.inject({
      method: 'POST',
      url: `/api/v1/tasks/${task.id}/claim`,
      headers,
      payload: { assignee: 'agent-1' },
    });

    const claimed = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.id}`,
      headers,
    });
    expect(claimed.statusCode).toBe(200);
    const claimedBody = JSON.parse(claimed.body);
    expect(claimedBody.claim_ttl_minutes).toBe(30);
    expect(claimedBody.claim_remaining_seconds).toBeGreaterThan(0);
    expect(claimedBody.claim_remaining_seconds).toBeLessThanOrEqual(30 * 60);

    // Unclaimed task: the additive fields stay absent.
    const openTask = createOpenTask('No TTL Fields');
    const open = await server.inject({
      method: 'GET',
      url: `/api/v1/tasks/${openTask.id}`,
      headers,
    });
    const openBody = JSON.parse(open.body);
    expect(openBody.claim_ttl_minutes).toBeUndefined();
    expect(openBody.claim_remaining_seconds).toBeUndefined();
  });
});
