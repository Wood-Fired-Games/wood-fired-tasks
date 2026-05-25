/**
 * Unit tests for src/mcp/remote/rest-client.ts (task #249).
 *
 * Stubs the global fetch so every method is exercised in-process without an
 * HTTP server. Covers the asPage envelope normalization plus each REST verb.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RestClient } from '../rest-client.js';

const ORIGINAL_FETCH = global.fetch;

function ok(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RestClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: RestClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new RestClient('http://localhost:3000/', 'test-key');
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it('strips trailing slash from baseUrl', () => {
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe(
      'http://localhost:3000'
    );
  });

  it('sends X-API-Key header on every request', async () => {
    fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 0, offset: 0 }));
    await client.listTasks();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('test-key');
  });

  // ── Phase 31 Plan 03 Task 3 — MCP-01 ─────────────────────────────────────
  //
  // The remote MCP server is a thin stdio→HTTP proxy: every incoming JSON-
  // RPC call becomes an outbound REST request. The auth header switches
  // based on the WFT_API_KEY prefix so a single env var works for both
  // legacy keys (`X-API-Key`) and PATs (`Authorization: Bearer`). Mirrors
  // the same precedent that Phase 30 Plan 05 wired into `src/cli/api/client.ts`.

  describe('auth header prefix detection (MCP-01)', () => {
    it('uses Authorization: Bearer when apiKey starts with wft_pat_', async () => {
      const patClient = new RestClient(
        'http://localhost:3000',
        'wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      );
      fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 0, offset: 0 }));
      await patClient.listTasks();
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(
        'Bearer wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      );
      // The PAT path MUST NOT also stamp X-API-Key — the server's auth
      // chain treats X-API-Key as the legacy strategy and could log a
      // deprecation warning for what should be a modern PAT request.
      expect(headers['X-API-Key']).toBeUndefined();
    });

    it('uses X-API-Key when apiKey does NOT start with wft_pat_ (legacy path)', async () => {
      const legacyClient = new RestClient(
        'http://localhost:3000',
        'legacy-style-no-prefix',
      );
      fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 0, offset: 0 }));
      await legacyClient.listTasks();
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['X-API-Key']).toBe('legacy-style-no-prefix');
      // The legacy path MUST NOT also stamp Authorization — keeping the
      // headers mutually exclusive prevents the server's auth chain from
      // first matching PAT (wrong-prefix → fail) before falling through
      // to legacy.
      expect(headers['Authorization']).toBeUndefined();
    });

    it('preserves apiKey verbatim in the Bearer body (no manipulation)', async () => {
      // Defensive: ensure the prefix detection only switches the HEADER
      // NAME and never mutates the token (e.g. strips the prefix). The
      // server expects the full `wft_pat_<body>` string for hash lookup.
      const fullToken = 'wft_pat_2222222222222222222222AAAAAAAAAA';
      const patClient = new RestClient('http://localhost:3000', fullToken);
      fetchMock.mockResolvedValue(ok({ id: 1 }));
      await patClient.getTask(1);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${fullToken}`);
    });
  });

  it('adds Content-Type header when sending a body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 1, title: 't', status: 'open' }));
    await client.createTask({
      title: 't',
      project_id: 1,
      created_by: 'tester',
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns parsed JSON on success', async () => {
    const payload = { id: 99, title: 'thing', status: 'open' };
    fetchMock.mockResolvedValue(ok(payload));
    const result = await client.getTask(99);
    expect(result).toEqual(payload);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/api/v1/tasks/99');
  });

  it('returns undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValue(noContent());
    await expect(client.deleteTask(1)).resolves.toBeUndefined();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('DELETE');
  });

  it('surfaces server error message from JSON body', async () => {
    fetchMock.mockResolvedValue(err(400, { message: 'bad input' }));
    await expect(client.getTask(1)).rejects.toThrow(/bad input/);
  });

  it('falls back to status text when body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json', { status: 500, statusText: 'Internal Server Error' })
    );
    await expect(client.getTask(1)).rejects.toThrow(/HTTP 500/);
  });

  it('wraps fetch network failures with a friendly hint', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client.getTask(1)).rejects.toThrow(/Cannot reach API server/);
  });

  it('rethrows non-fetch errors unchanged', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(client.getTask(1)).rejects.toThrow(/boom/);
  });

  // ── List endpoints with paginated/array unification ───────────────────

  it('listTasks unwraps an array payload via asPage', async () => {
    fetchMock.mockResolvedValue(ok([{ id: 1 }, { id: 2 }]));
    const list = await client.listTasks();
    expect(list).toHaveLength(2);
  });

  it('listTasksPaginated returns the envelope shape', async () => {
    fetchMock.mockResolvedValue(
      ok({ data: [{ id: 1 }], total: 1, limit: 50, offset: 0 })
    );
    const page = await client.listTasksPaginated();
    expect(page.total).toBe(1);
    expect(page.data).toHaveLength(1);
  });

  it('listTasksPaginated normalizes malformed payloads to empty envelope', async () => {
    fetchMock.mockResolvedValue(ok({ unexpected: 'shape' }));
    const page = await client.listTasksPaginated();
    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('listTasks serializes filters into the query string', async () => {
    fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 0, offset: 0 }));
    await client.listTasks({
      status: 'open',
      project_id: 5,
      tags: 'urgent',
      limit: 10,
      offset: 20,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('status=open');
    expect(url).toContain('project_id=5');
    expect(url).toContain('tags=urgent');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
  });

  it('claimTask POSTs the assignee', async () => {
    fetchMock.mockResolvedValue(ok({ id: 1 }));
    await client.claimTask(1, 'agent-a');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ assignee: 'agent-a' });
  });

  it('updateTask sends PUT with body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 1 }));
    await client.updateTask(1, { title: 'new' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
  });

  // ── Subtasks / projects / dependencies / comments paths ────────────────

  it('getSubtasksPaginated supports limit/offset query params', async () => {
    fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 5, offset: 10 }));
    await client.getSubtasksPaginated(7, { limit: 5, offset: 10 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/tasks/7/subtasks');
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=10');
  });

  it('getSubtasks returns just the data slice', async () => {
    fetchMock.mockResolvedValue(ok([{ id: 1 }]));
    const list = await client.getSubtasks(7);
    expect(list).toHaveLength(1);
  });

  it('listProjectsPaginated honors pagination', async () => {
    fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 5, offset: 0 }));
    await client.listProjectsPaginated({ limit: 5 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=5');
  });

  it('listProjects unwraps a paginated envelope', async () => {
    fetchMock.mockResolvedValue(
      ok({ data: [{ id: 1, name: 'p' }], total: 1, limit: 50, offset: 0 })
    );
    const projects = await client.listProjects();
    expect(projects).toHaveLength(1);
  });

  it('createProject sends POST with body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 1, name: 'p' }));
    await client.createProject({ name: 'p' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  it('updateProject sends PUT with body', async () => {
    fetchMock.mockResolvedValue(ok({ id: 1, name: 'q' }));
    await client.updateProject(1, { name: 'q' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
  });

  it('deleteProject sends DELETE and resolves on 204', async () => {
    fetchMock.mockResolvedValue(noContent());
    await expect(client.deleteProject(2)).resolves.toBeUndefined();
  });

  it('addDependency POSTs and removeDependency DELETEs', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 1, task_id: 1, blocks_task_id: 2 }));
    await client.addDependency(1, { blocks_task_id: 2 });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');

    fetchMock.mockResolvedValueOnce(noContent());
    await client.removeDependency(1, 2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('getDependencies returns the dependency envelope', async () => {
    fetchMock.mockResolvedValue(ok({ blocks: [], blocked_by: [] }));
    const deps = await client.getDependencies(1);
    expect(deps.blocks).toEqual([]);
    expect(deps.blocked_by).toEqual([]);
  });

  it('addComment POSTs the author and content', async () => {
    fetchMock.mockResolvedValue(ok({ id: 1, task_id: 1 }));
    await client.addComment(1, { author: 'a', content: 'c' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      author: 'a',
      content: 'c',
    });
  });

  it('getCommentsPaginated honors limit/offset', async () => {
    fetchMock.mockResolvedValue(ok({ data: [], total: 0, limit: 3, offset: 6 }));
    await client.getCommentsPaginated(1, { limit: 3, offset: 6 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('limit=3');
    expect(url).toContain('offset=6');
  });

  it('getComments unwraps array payload', async () => {
    fetchMock.mockResolvedValue(ok([{ id: 1 }]));
    const list = await client.getComments(1);
    expect(list).toHaveLength(1);
  });

  it('deleteComment DELETEs the resource', async () => {
    fetchMock.mockResolvedValue(noContent());
    await client.deleteComment(1, 2);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('DELETE');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/tasks/1/comments/2');
  });

  // ── Completion report query construction ───────────────────────────────

  it('getCompletionReport serializes days param', async () => {
    fetchMock.mockResolvedValue(
      ok({
        range: { start: 's', end: 'e' },
        total: 0,
        rows: [],
        by_project: [],
        by_assignee: [],
        by_priority: [],
        daily_throughput: [],
      })
    );
    await client.getCompletionReport({ days: 14 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/tasks/completion-report');
    expect(url).toContain('days=14');
  });

  it('getCompletionReport serializes start/end/project_id/assignee', async () => {
    fetchMock.mockResolvedValue(
      ok({
        range: { start: 's', end: 'e' },
        total: 0,
        rows: [],
        by_project: [],
        by_assignee: [],
        by_priority: [],
        daily_throughput: [],
      })
    );
    await client.getCompletionReport({
      start: '2026-01-01T00:00:00Z',
      end: '2026-02-01T00:00:00Z',
      project_id: 7,
      assignee: 'alice',
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('start=');
    expect(url).toContain('end=');
    expect(url).toContain('project_id=7');
    expect(url).toContain('assignee=alice');
  });

  it('getCompletionReport with empty input omits the query string', async () => {
    fetchMock.mockResolvedValue(
      ok({
        range: { start: 's', end: 'e' },
        total: 0,
        rows: [],
        by_project: [],
        by_assignee: [],
        by_priority: [],
        daily_throughput: [],
      })
    );
    await client.getCompletionReport({});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:3000/api/v1/tasks/completion-report');
  });

  it('checkHealth hits /health/detailed (authenticated, no /api/v1 prefix)', async () => {
    fetchMock.mockResolvedValue(
      ok({
        status: 'healthy',
        timestamp: 't',
        version: '1.0.0',
        database: { path: '/tmp/tasks.db', projects: 2, maxTaskId: 9, latestActivity: '2026-05-25T00:00:00.000Z' },
        checks: { database: 'ok' },
      })
    );
    const health = await client.checkHealth();
    expect(health.status).toBe('healthy');
    expect(health.database?.path).toBe('/tmp/tasks.db');
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3000/health/detailed');
  });

  // ── Error body parsing branches ────────────────────────────────────────

  it('uses body.error when message is absent', async () => {
    fetchMock.mockResolvedValue(err(404, { error: 'not found' }));
    await expect(client.getTask(1)).rejects.toThrow(/not found/);
  });

  it('falls back to "HTTP NNN: status text" when body lacks both fields', async () => {
    fetchMock.mockResolvedValue(err(503, { something: 'else' }));
    await expect(client.getTask(1)).rejects.toThrow(/HTTP 503/);
  });
});
