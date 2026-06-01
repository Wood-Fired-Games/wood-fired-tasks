/**
 * Unit tests for src/mcp/remote/register-tools.ts (task #249).
 *
 * `registerRemoteTools(server, client)` registers ~21 MCP tools and binds each
 * handler closure to a captured RestClient method. Pre-existing coverage was
 * 0 % because the only test (#245 completion-report parity) stood up a real
 * Fastify server and only exercised one tool indirectly. This suite uses a
 * stub McpServer to harvest each registered handler and drive it with a mock
 * client, exercising both the success and error branches.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerRemoteTools } from '../register-tools.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

/**
 * Build a stub MCP server that records every registerTool() call so individual
 * tests can pull a specific handler out and invoke it directly.
 */
function makeFakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, cb: Handler) => {
        handlers.set(name, cb);
        return { name };
      }
    ),
  };
  return { server, handlers };
}

function makeMockClient() {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    listTasksPaginated: vi.fn(),
    deleteTask: vi.fn(),
    claimTask: vi.fn(),
    getSubtasksPaginated: vi.fn(),
    getCompletionReport: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listProjectsPaginated: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    getDependencies: vi.fn(),
    addComment: vi.fn(),
    getCommentsPaginated: vi.fn(),
    deleteComment: vi.fn(),
    checkHealth: vi.fn(),
    getTopology: vi.fn(),
    getWsjfRanking: vi.fn(),
    getWsjfHistory: vi.fn(),
    getWsjfHealth: vi.fn(),
    rescoreProject: vi.fn(),
    waitForUnblockViaSse: vi.fn(),
  };
}

describe('registerRemoteTools', () => {
  let server: ReturnType<typeof makeFakeServer>['server'];
  let handlers: Map<string, Handler>;
  let client: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    const built = makeFakeServer();
    server = built.server;
    handlers = built.handlers;
    client = makeMockClient();
    registerRemoteTools(
      server as unknown as Parameters<typeof registerRemoteTools>[0],
      client as unknown as Parameters<typeof registerRemoteTools>[1]
    );
  });

  it('registers all expected tools', () => {
    const expected = [
      'create_task',
      'get_task',
      'update_task',
      'list_tasks',
      'delete_task',
      'claim_task',
      'list_subtasks',
      'get_subtasks',
      'completion_report',
      'create_project',
      'get_project',
      'list_projects',
      'update_project',
      'delete_project',
      'add_dependency',
      'remove_dependency',
      'get_dependencies',
      'add_comment',
      'get_comments',
      'delete_comment',
      'check_health',
      'topology_check',
      'wsjf_ranking',
      'wsjf_history',
      'rescore_project',
      'wsjf_health',
      'wait_for_unblock',
    ];
    for (const name of expected) {
      expect(handlers.has(name)).toBe(true);
    }
    expect(handlers.size).toBe(expected.length);
  });

  // ── Task tools ───────────────────────────────────────────────────────────

  it('create_task formats success summary and structuredContent', async () => {
    client.createTask.mockResolvedValue({
      id: 7,
      title: 'hello',
      status: 'open',
    });
    const handler = handlers.get('create_task')!;
    const result = await handler({ title: 'hello' });
    expect(result.content[0].text).toContain('Task created');
    expect(result.content[0].text).toContain('ID: 7');
    expect(result.structuredContent).toMatchObject({ id: 7 });
  });

  it('create_task wraps errors in McpError', async () => {
    client.createTask.mockRejectedValue(new Error('boom'));
    const handler = handlers.get('create_task')!;
    await expect(handler({ title: 'x' })).rejects.toBeInstanceOf(McpError);
  });

  it('get_task renders summary with optional fields', async () => {
    client.getTask.mockResolvedValue({
      id: 1,
      title: 't',
      description: 'd',
      status: 'open',
      priority: 'high',
      assignee: 'a',
      due_date: '2026-06-01',
      tags: ['x', 'y'],
    });
    const handler = handlers.get('get_task')!;
    const r = await handler({ id: 1 });
    expect(r.content[0].text).toContain('Description: d');
    expect(r.content[0].text).toContain('Assignee: a');
    expect(r.content[0].text).toContain('Due:');
    expect(r.content[0].text).toContain('Tags: x, y');
  });

  it('get_task error path', async () => {
    client.getTask.mockRejectedValue(new Error('nope'));
    await expect(handlers.get('get_task')!({ id: 1 })).rejects.toBeInstanceOf(
      McpError
    );
  });

  it('update_task summary includes status + priority', async () => {
    client.updateTask.mockResolvedValue({
      id: 2,
      title: 'new',
      status: 'done',
      priority: 'low',
    });
    const r = await handlers.get('update_task')!({ id: 2, updates: { title: 'new' } });
    expect(r.content[0].text).toContain('Task 2 updated');
    expect(r.content[0].text).toContain('Status: done');
  });

  it('update_task error path', async () => {
    client.updateTask.mockRejectedValue(new Error('x'));
    await expect(
      handlers.get('update_task')!({ id: 1, updates: {} })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('list_tasks returns "no tasks" message when result is empty', async () => {
    client.listTasksPaginated.mockResolvedValue({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_tasks')!({});
    expect(r.content[0].text).toContain('No tasks found');
    expect(r.structuredContent).toMatchObject({ tasks: [], total: 0 });
  });

  it('list_tasks renders compact list by default', async () => {
    client.listTasksPaginated.mockResolvedValue({
      data: [
        { id: 1, title: 't1', status: 'open', priority: 'medium', tags: [] },
        { id: 2, title: 't2', status: 'done', priority: 'high', tags: [] },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_tasks')!({});
    expect(r.content[0].text).toContain('Found 2 of 2 task(s)');
    expect(r.content[0].text).toContain('[1] t1');
    expect(r.content[0].text).toContain('[2] t2');
    expect(r.structuredContent).toMatchObject({ total: 2 });
  });

  it('list_tasks verbose=true returns full task objects', async () => {
    client.listTasksPaginated.mockResolvedValue({
      data: [
        {
          id: 1,
          title: 't',
          description: 'long-desc',
          status: 'open',
          priority: 'medium',
          tags: [],
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_tasks')!({ verbose: true });
    const tasks = (r.structuredContent as { tasks: Array<Record<string, unknown>> })
      .tasks;
    expect(tasks[0]).toHaveProperty('description', 'long-desc');
  });

  it('list_tasks error path', async () => {
    client.listTasksPaginated.mockRejectedValue(new Error('y'));
    await expect(handlers.get('list_tasks')!({})).rejects.toBeInstanceOf(
      McpError
    );
  });

  it('delete_task success', async () => {
    client.deleteTask.mockResolvedValue(undefined);
    const r = await handlers.get('delete_task')!({ id: 3 });
    expect(r.content[0].text).toContain('Task 3 deleted');
  });

  it('delete_task error path', async () => {
    client.deleteTask.mockRejectedValue(new Error('z'));
    await expect(
      handlers.get('delete_task')!({ id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('claim_task success', async () => {
    client.claimTask.mockResolvedValue({ id: 4, status: 'in_progress' });
    const r = await handlers.get('claim_task')!({ task_id: 4, assignee: 'a' });
    expect(r.content[0].text).toContain('claimed by "a"');
  });

  it('claim_task error path', async () => {
    client.claimTask.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('claim_task')!({ task_id: 1, assignee: 'a' })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('list_subtasks empty path', async () => {
    client.getSubtasksPaginated.mockResolvedValue({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_subtasks')!({ task_id: 5 });
    expect(r.content[0].text).toContain('has no subtasks');
  });

  it('list_subtasks populated path', async () => {
    client.getSubtasksPaginated.mockResolvedValue({
      data: [{ id: 10, title: 'sub', status: 'open' }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_subtasks')!({ task_id: 5 });
    expect(r.content[0].text).toContain('1 of 1 subtask(s)');
  });

  it('list_subtasks error path', async () => {
    client.getSubtasksPaginated.mockRejectedValue(new Error('x'));
    await expect(
      handlers.get('list_subtasks')!({ task_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('get_subtasks returns text summary', async () => {
    client.getSubtasksPaginated.mockResolvedValue({
      data: [{ id: 1 }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('get_subtasks')!({ task_id: 1 });
    expect(r.content[0].text).toContain('Found 1 of 1 subtask(s)');
  });

  it('get_subtasks error path', async () => {
    client.getSubtasksPaginated.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('get_subtasks')!({ task_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('completion_report with rows shows aggregates', async () => {
    client.getCompletionReport.mockResolvedValue({
      range: { start: 'A', end: 'B' },
      total: 2,
      rows: [],
      by_project: [{ project_id: 1, count: 2 }],
      by_assignee: [{ assignee: 'alice', count: 2 }],
      by_priority: [],
      daily_throughput: [],
    });
    const r = await handlers.get('completion_report')!({ days: 7 });
    expect(r.content[0].text).toContain('2 task(s) completed');
    expect(r.content[0].text).toContain('Top by project');
    expect(r.content[0].text).toContain('Top by assignee');
  });

  it('completion_report with 0 rows omits aggregate sections', async () => {
    client.getCompletionReport.mockResolvedValue({
      range: { start: 'A', end: 'B' },
      total: 0,
      rows: [],
      by_project: [],
      by_assignee: [],
      by_priority: [],
      daily_throughput: [],
    });
    const r = await handlers.get('completion_report')!({ days: 7 });
    expect(r.content[0].text).toContain('0 task(s) completed');
    expect(r.content[0].text).not.toContain('Top by project');
  });

  it('completion_report error path', async () => {
    client.getCompletionReport.mockRejectedValue(new Error('q'));
    await expect(
      handlers.get('completion_report')!({ days: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  // ── Project tools ────────────────────────────────────────────────────────

  it('create_project success', async () => {
    client.createProject.mockResolvedValue({ id: 1, name: 'p' });
    const r = await handlers.get('create_project')!({ name: 'p' });
    expect(r.content[0].text).toContain('Project created');
  });

  it('create_project error path', async () => {
    client.createProject.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('create_project')!({ name: 'p' })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('get_project with description', async () => {
    client.getProject.mockResolvedValue({
      id: 1,
      name: 'p',
      description: 'd',
      created_at: 'now',
    });
    const r = await handlers.get('get_project')!({ id: 1 });
    expect(r.content[0].text).toContain('Project: p');
    expect(r.content[0].text).toContain('Description: d');
  });

  it('get_project without description', async () => {
    client.getProject.mockResolvedValue({
      id: 1,
      name: 'p',
      description: null,
      created_at: 'now',
    });
    const r = await handlers.get('get_project')!({ id: 1 });
    expect(r.content[0].text).not.toContain('Description:');
  });

  it('get_project error path', async () => {
    client.getProject.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('get_project')!({ id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('list_projects empty', async () => {
    client.listProjectsPaginated.mockResolvedValue({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_projects')!({});
    expect(r.content[0].text).toContain('No projects found');
  });

  it('list_projects with rows', async () => {
    client.listProjectsPaginated.mockResolvedValue({
      data: [{ id: 1, name: 'p1' }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('list_projects')!({});
    expect(r.content[0].text).toContain('Found 1 of 1 project(s)');
  });

  it('list_projects error path', async () => {
    client.listProjectsPaginated.mockRejectedValue(new Error('e'));
    await expect(handlers.get('list_projects')!({})).rejects.toBeInstanceOf(
      McpError
    );
  });

  it('update_project success', async () => {
    client.updateProject.mockResolvedValue({ id: 1, name: 'q' });
    const r = await handlers.get('update_project')!({
      id: 1,
      updates: { name: 'q' },
    });
    expect(r.content[0].text).toContain('Project 1 updated');
  });

  it('update_project error path', async () => {
    client.updateProject.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('update_project')!({ id: 1, updates: {} })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('delete_project success', async () => {
    client.deleteProject.mockResolvedValue(undefined);
    const r = await handlers.get('delete_project')!({ id: 1 });
    expect(r.content[0].text).toContain('Project 1 deleted');
  });

  it('delete_project error path', async () => {
    client.deleteProject.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('delete_project')!({ id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  // ── Dependency tools ─────────────────────────────────────────────────────

  it('add_dependency success', async () => {
    client.addDependency.mockResolvedValue({
      id: 1,
      task_id: 1,
      blocks_task_id: 2,
      created_at: 'now',
    });
    const r = await handlers.get('add_dependency')!({
      task_id: 1,
      blocks_task_id: 2,
    });
    expect(r.content[0].text).toContain('blocks Task 2');
  });

  it('add_dependency error path', async () => {
    client.addDependency.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('add_dependency')!({ task_id: 1, blocks_task_id: 2 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('remove_dependency success', async () => {
    client.removeDependency.mockResolvedValue(undefined);
    const r = await handlers.get('remove_dependency')!({
      task_id: 1,
      blocks_task_id: 2,
    });
    expect(r.content[0].text).toContain('no longer blocks Task 2');
  });

  it('remove_dependency error path', async () => {
    client.removeDependency.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('remove_dependency')!({ task_id: 1, blocks_task_id: 2 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('get_dependencies success', async () => {
    client.getDependencies.mockResolvedValue({
      blocks: [{ id: 1, task_id: 1, blocks_task_id: 2, created_at: 'now' }],
      blocked_by: [],
    });
    const r = await handlers.get('get_dependencies')!({ task_id: 1 });
    expect(r.content[0].text).toContain('blocks 1 task(s)');
    expect(r.content[0].text).toContain('blocked by 0 task(s)');
  });

  it('get_dependencies handles missing arrays', async () => {
    client.getDependencies.mockResolvedValue({});
    const r = await handlers.get('get_dependencies')!({ task_id: 1 });
    expect(r.content[0].text).toContain('blocks 0 task(s)');
  });

  it('get_dependencies error path', async () => {
    client.getDependencies.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('get_dependencies')!({ task_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  // ── Comment tools ───────────────────────────────────────────────────────

  it('add_comment success', async () => {
    client.addComment.mockResolvedValue({
      id: 1,
      task_id: 1,
      author: 'a',
      content: 'c',
      created_at: 'now',
    });
    const r = await handlers.get('add_comment')!({
      task_id: 1,
      author: 'a',
      content: 'c',
    });
    expect(r.content[0].text).toContain('Comment added by a');
  });

  it('add_comment error path', async () => {
    client.addComment.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('add_comment')!({ task_id: 1, author: 'a', content: 'c' })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('get_comments success', async () => {
    client.getCommentsPaginated.mockResolvedValue({
      data: [{ id: 1 }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    const r = await handlers.get('get_comments')!({ task_id: 1 });
    expect(r.content[0].text).toContain('1 of 1 comment(s)');
  });

  it('get_comments error path', async () => {
    client.getCommentsPaginated.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('get_comments')!({ task_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('delete_comment success', async () => {
    client.deleteComment.mockResolvedValue(undefined);
    const r = await handlers.get('delete_comment')!({ comment_id: 9 });
    expect(r.content[0].text).toContain('Comment 9 deleted');
    expect(client.deleteComment).toHaveBeenCalledWith(1, 9);
  });

  it('delete_comment error path', async () => {
    client.deleteComment.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('delete_comment')!({ comment_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  // ── Health tool ─────────────────────────────────────────────────────────

  it('check_health success path returns formatted text + structuredContent', async () => {
    client.checkHealth.mockResolvedValue({
      status: 'healthy',
      timestamp: '2026-05-21T10:00:00Z',
      version: '1.12.0',
      checks: { database: 'ok' },
    });
    const r = await handlers.get('check_health')!({});
    expect(r.content[0].text).toContain('Service Status: healthy');
    expect(r.content[0].text).toContain('Database: ok');
    expect(r.structuredContent).toMatchObject({ status: 'healthy' });
  });

  it('check_health fills in defaults when payload is sparse', async () => {
    client.checkHealth.mockResolvedValue({});
    const r = await handlers.get('check_health')!({});
    expect(r.content[0].text).toContain('Service Status: unknown');
    expect(r.content[0].text).toContain('Database: unknown');
  });

  it('check_health error path returns synthetic unhealthy envelope (does NOT throw)', async () => {
    client.checkHealth.mockRejectedValue(new Error('connection refused'));
    const r = await handlers.get('check_health')!({});
    expect(r.content[0].text).toContain('Service Status: unhealthy');
    expect(r.content[0].text).toContain('Error: connection refused');
    expect(r.structuredContent).toMatchObject({
      status: 'unhealthy',
      checks: { database: 'failed' },
    });
  });

  it('check_health error path with non-Error rejection still returns envelope', async () => {
    client.checkHealth.mockRejectedValue('bare string');
    const r = await handlers.get('check_health')!({});
    expect(r.content[0].text).toContain('Service Status: unhealthy');
    expect(r.content[0].text).toContain('Unknown error');
  });

  // ── Topology tool ─────────────────────────────────────────────────────────

  it('topology_check is registered (parity with stdio MCP)', () => {
    expect(handlers.has('topology_check')).toBe(true);
  });

  it('topology_check formats summary + passes report through as structuredContent', async () => {
    const report = {
      topology: 'DAG',
      edges: [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
      ],
      roots: [1],
      leaves: [3],
      advisory: '/tasks:loop-dag',
    };
    client.getTopology.mockResolvedValue(report);
    const r = await handlers.get('topology_check')!({ project_id: 42 });
    expect(client.getTopology).toHaveBeenCalledWith(42);
    expect(r.content[0].text).toBe(
      'Project 42: topology=DAG, advisory=/tasks:loop-dag, edges=2, roots=1, leaves=1'
    );
    // structuredContent must be the raw TopologyReport, unchanged — this is
    // what makes the remote tool indistinguishable from the stdio one.
    expect(r.structuredContent).toEqual(report);
  });

  it('topology_check FLAT project renders /tasks:loop advisory', async () => {
    client.getTopology.mockResolvedValue({
      topology: 'FLAT',
      edges: [],
      roots: [1, 2],
      leaves: [1, 2],
      advisory: '/tasks:loop',
    });
    const r = await handlers.get('topology_check')!({ project_id: 7 });
    expect(r.content[0].text).toContain('topology=FLAT');
    expect(r.content[0].text).toContain('advisory=/tasks:loop');
    expect(r.content[0].text).toContain('edges=0');
  });

  it('topology_check error path wraps in McpError', async () => {
    client.getTopology.mockRejectedValue(new Error('boom'));
    await expect(
      handlers.get('topology_check')!({ project_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  // ── WSJF tools (remote parity, WSJF 1.10) ─────────────────────────────────

  it('wsjf_ranking proxies the REST ranking + formats ordered summary', async () => {
    client.getWsjfRanking.mockResolvedValue({
      project_id: 3,
      scope: 'frontier',
      total: 2,
      ranking: [
        {
          taskId: 10,
          scored: true,
          baseWsjf: 2.5,
          effectiveWsjf: 3.25,
          components: { value: 8, timeCriticality: 5, riskOpportunity: 3, jobSize: 2 },
          propagation: [{ dependentId: 11, contribution: 0.75 }],
          evidence: null,
        },
        {
          taskId: 11,
          scored: false,
          baseWsjf: null,
          effectiveWsjf: 0,
          components: null,
          propagation: [],
          evidence: null,
        },
      ],
    });
    const r = await handlers.get('wsjf_ranking')!({ project_id: 3 });
    expect(client.getWsjfRanking).toHaveBeenCalledWith(3, 'frontier');
    expect(r.content[0].text).toContain('Ranked 2 task(s) for project 3');
    expect(r.content[0].text).toContain('1. [10] effectiveWsjf=3.250 (scored, base=2.500)');
    expect(r.content[0].text).toContain('2. [11] effectiveWsjf=0.000 (unscored)');
    expect(r.structuredContent).toMatchObject({ project_id: 3, scope: 'frontier' });
  });

  it('wsjf_ranking forwards scope=all', async () => {
    client.getWsjfRanking.mockResolvedValue({
      project_id: 5,
      scope: 'all',
      total: 0,
      ranking: [],
    });
    await handlers.get('wsjf_ranking')!({ project_id: 5, scope: 'all' });
    expect(client.getWsjfRanking).toHaveBeenCalledWith(5, 'all');
  });

  it('wsjf_ranking error path wraps in McpError', async () => {
    client.getWsjfRanking.mockRejectedValue(new Error('boom'));
    await expect(
      handlers.get('wsjf_ranking')!({ project_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('wsjf_history annotates deltas + formats timeline', async () => {
    client.getWsjfHistory.mockResolvedValue({
      task_id: 7,
      total: 2,
      history: [
        {
          id: 1,
          task_id: 7,
          project_id: 1,
          changed_at: '2026-01-01T00:00:00Z',
          trigger: 'create',
          wsjf_score: 2,
          prev_wsjf_score: null,
          value: 8,
        },
        {
          id: 2,
          task_id: 7,
          project_id: 1,
          changed_at: '2026-02-01T00:00:00Z',
          trigger: 'rescore',
          wsjf_score: 4,
          prev_wsjf_score: 2,
          value: 13,
        },
      ],
    });
    const r = await handlers.get('wsjf_history')!({ task_id: 7 });
    expect(client.getWsjfHistory).toHaveBeenCalledWith(7);
    expect(r.content[0].text).toContain('Task 7 has 2 WSJF history entries');
    expect(r.content[0].text).toContain('[create] wsjf ∅→2');
    expect(r.content[0].text).toContain('[rescore] wsjf 2→4');
    const sc = r.structuredContent as {
      timeline: Array<{ deltas: Record<string, { from: number | null; to: number | null }> }>;
    };
    expect(sc.timeline[1].deltas.wsjf_score).toEqual({ from: 2, to: 4 });
  });

  it('wsjf_history error path wraps in McpError', async () => {
    client.getWsjfHistory.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('wsjf_history')!({ task_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('rescore_project proxies submissions + formats run summary with errors', async () => {
    client.rescoreProject.mockResolvedValue({
      run_id: 99,
      project_id: 4,
      tasks_evaluated: 3,
      tasks_changed: 1,
      tasks_skipped_locked: 1,
      results: [],
      errors: [{ taskId: 12, errors: ['contradiction'] }],
    });
    const r = await handlers.get('rescore_project')!({
      project_id: 4,
      submissions: [
        { task_id: 12, classification: { a: 1 }, features: { b: 2 } },
      ],
      actor_type: 'agent',
      actor_id: 'bot-1',
    });
    expect(client.rescoreProject).toHaveBeenCalledWith(
      4,
      [{ task_id: 12, classification: { a: 1 }, features: { b: 2 } }],
      { actor_type: 'agent', actor_id: 'bot-1' }
    );
    expect(r.content[0].text).toContain('Rescore run 99 for project 4');
    expect(r.content[0].text).toContain('3 evaluated, 1 changed, 1 with locked');
    expect(r.content[0].text).toContain('[12] contradiction');
    expect(r.structuredContent).toMatchObject({ run_id: 99, project_id: 4 });
  });

  it('rescore_project defaults empty submissions + omits actor when absent', async () => {
    client.rescoreProject.mockResolvedValue({
      run_id: 1,
      project_id: 4,
      tasks_evaluated: 0,
      tasks_changed: 0,
      tasks_skipped_locked: 0,
      results: [],
      errors: [],
    });
    await handlers.get('rescore_project')!({ project_id: 4 });
    expect(client.rescoreProject).toHaveBeenCalledWith(4, [], {});
  });

  it('rescore_project error path wraps in McpError', async () => {
    client.rescoreProject.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('rescore_project')!({ project_id: 1, submissions: [] })
    ).rejects.toBeInstanceOf(McpError);
  });

  it('wsjf_health formats OK summary on a healthy project', async () => {
    client.getWsjfHealth.mockResolvedValue({
      project_id: 8,
      healthy: true,
      scored_task_count: 5,
      findings: [],
    });
    const r = await handlers.get('wsjf_health')!({ project_id: 8 });
    expect(client.getWsjfHealth).toHaveBeenCalledWith(8);
    expect(r.content[0].text).toContain('Project 8 WSJF health: OK');
    expect(r.content[0].text).toContain('5 scored task(s)');
    expect(r.structuredContent).toMatchObject({ healthy: true });
  });

  it('wsjf_health lists findings on a degenerate project', async () => {
    client.getWsjfHealth.mockResolvedValue({
      project_id: 8,
      healthy: false,
      scored_task_count: 4,
      findings: [
        {
          check: 'degenerate-spread',
          severity: 'warning',
          message: 'Scores too close.',
          suggestion: 'Spread them.',
          taskIds: [1, 2],
        },
      ],
    });
    const r = await handlers.get('wsjf_health')!({ project_id: 8 });
    expect(r.content[0].text).toContain('1 finding(s)');
    expect(r.content[0].text).toContain('[warning] degenerate-spread: Scores too close. Fix: Spread them.');
  });

  it('wsjf_health error path wraps in McpError', async () => {
    client.getWsjfHealth.mockRejectedValue(new Error('e'));
    await expect(
      handlers.get('wsjf_health')!({ project_id: 1 })
    ).rejects.toBeInstanceOf(McpError);
  });
});
