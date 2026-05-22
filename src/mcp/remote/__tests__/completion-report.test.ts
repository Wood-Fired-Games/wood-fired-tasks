import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../api/server.js';
import type { App } from '../../../index.js';
import { RestClient } from '../rest-client.js';

// Set API key for tests BEFORE createServer so authPlugin reads it.
process.env.API_KEYS = 'remote-mcp-test-key';

/**
 * Remote MCP `completion_report` parity test (task #245).
 *
 * Strategy: spin up the real Fastify server on an ephemeral loopback port,
 * point a `RestClient` at it, and exercise `getCompletionReport`. This is
 * the exact pipe the remote MCP tool wrapper uses — proving the REST hop
 * works end-to-end is equivalent to proving the wrapper works, because the
 * wrapper itself is just a passthrough that formats `summary` text from the
 * structured envelope. The wrapper has no branching logic of its own.
 */
describe('RestClient.getCompletionReport (remote MCP parity for #245)', () => {
  let server: FastifyInstance;
  let app: App;
  let client: RestClient;
  let projectAId: number;
  let projectBId: number;

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;

    // Bind to ephemeral port — kernel picks a free port so parallel test
    // files don't collide. Returned string is "http://127.0.0.1:NNNNN".
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    client = new RestClient(baseUrl, 'remote-mcp-test-key');

    projectAId = app.projectService.createProject({ name: 'Alpha' }).id;
    projectBId = app.projectService.createProject({ name: 'Beta' }).id;
  }, 30_000);

  afterAll(async () => {
    await server.close();
    app.dispose();
  });

  /** Helper: walk a task open → in_progress → done so completed_at is set. */
  function completeTask(
    projectId: number,
    title: string,
    opts: { assignee?: string; priority?: 'low' | 'medium' | 'high' | 'urgent' } = {}
  ): void {
    const task = app.taskService.createTask({
      title,
      project_id: projectId,
      created_by: 'tester',
      priority: opts.priority ?? 'medium',
    });
    app.taskService.updateTask(task.id, {
      status: 'in_progress',
      assignee: opts.assignee ?? null,
    });
    app.taskService.updateTask(task.id, { status: 'done' });
  }

  it('proxies a trailing window report end-to-end', async () => {
    completeTask(projectAId, 'a1', { assignee: 'alice', priority: 'high' });
    completeTask(projectAId, 'a2', { assignee: 'bob', priority: 'high' });
    completeTask(projectBId, 'b1', { assignee: 'alice', priority: 'low' });

    const report = await client.getCompletionReport({ days: 30 });

    expect(report.total).toBe(3);
    expect(report.rows).toHaveLength(3);
    expect(report.by_project).toContainEqual({ project_id: projectAId, count: 2 });
    expect(report.by_project).toContainEqual({ project_id: projectBId, count: 1 });
    expect(report.by_assignee).toContainEqual({ assignee: 'alice', count: 2 });
    expect(report.by_priority).toContainEqual({ priority: 'high', count: 2 });
    expect(report.range.start).toBeTruthy();
    expect(report.range.end).toBeTruthy();
  });

  it('passes project_id filter through query string', async () => {
    const report = await client.getCompletionReport({
      days: 30,
      project_id: projectAId,
    });
    expect(report.total).toBeGreaterThan(0);
    expect(report.rows.every((r) => r.project_id === projectAId)).toBe(true);
  });

  it('passes assignee filter through query string', async () => {
    const report = await client.getCompletionReport({
      days: 30,
      assignee: 'alice',
    });
    expect(report.total).toBeGreaterThan(0);
    expect(report.rows.every((r) => r.assignee === 'alice')).toBe(true);
  });

  it('passes explicit start/end through query string', async () => {
    const report = await client.getCompletionReport({
      start: '2020-01-01T00:00:00.000Z',
      end: '2020-12-31T23:59:59.000Z',
    });
    // Past window — no fixtures fall inside it.
    expect(report.total).toBe(0);
  });

  it('surfaces server-side validation errors when neither form is supplied', async () => {
    await expect(
      client.getCompletionReport({})
    ).rejects.toThrow(/API request failed/);
  });

  it('surfaces server-side validation errors when end precedes start', async () => {
    await expect(
      client.getCompletionReport({
        start: '2026-02-01T00:00:00Z',
        end: '2026-01-01T00:00:00Z',
      })
    ).rejects.toThrow(/API request failed/);
  });
});
