import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../api/server.js';
import type { App } from '../../../index.js';
import type { AuditEventRow } from '../../../repositories/audit-event.repository.js';
import { createMcpServer } from '../../server.js';
import { RestClient } from '../rest-client.js';
import { registerRemoteTools } from '../register-tools.js';
import { seedAuth } from '../../../api/__tests__/helpers/auth.js';

/**
 * End to end through the remote bridge (WFT #2483, design §5 — the
 * production-reachability gate for the archived project state).
 *
 * Every step is a tool call through the REAL pipe production uses: MCP
 * client → the tools `registerRemoteTools` registers → `RestClient` → a real
 * Fastify server on a loopback port. No step reaches into a service to set
 * state up; the app handle is used only to read the audit trail through its
 * owning repository. A stdio MCP server over the SAME app runs beside it for
 * the stdio-unarchive re-evaluation case.
 */

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('end to end: archived project state through the remote bridge', () => {
  let server: FastifyInstance;
  let app: App;
  let baseUrl: string;
  let token: string;
  let remote: Client;
  let stdio: Client;
  const transports: InMemoryTransport[] = [];
  let sequence = 0;

  async function connect(mcpServer: McpServer, name: string): Promise<Client> {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    transports.push(serverSide, clientSide);
    await mcpServer.connect(serverSide);
    const client = new Client({ name, version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientSide);
    return client;
  }

  beforeAll(async () => {
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    app = result.app;
    baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    token = seedAuth(app.db, { displayName: 'e2e-archiver' }).token;

    const remoteServer = new McpServer({ name: 'remote-e2e', version: '1.0.0' });
    registerRemoteTools(remoteServer, new RestClient(baseUrl, token));
    remote = await connect(remoteServer, 'remote-client');

    stdio = await connect(
      createMcpServer(
        app.taskService,
        app.projectService,
        app.dependencyService,
        app.commentService,
        app.db,
      ),
      'stdio-client',
    );
  }, 30_000);

  afterAll(async () => {
    for (const transport of transports) {
      await transport.close();
    }
    await server.close();
    app.dispose();
  });

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  /** Call a remote tool that must succeed; return its structured content. */
  async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await call(remote, name, args);
    expect(result.isError, `${name}: ${result.content[0]?.text ?? ''}`).toBeFalsy();
    return result.structuredContent ?? {};
  }

  function text(result: ToolResult): string {
    return result.content[0]?.text ?? '';
  }

  async function createProject(label: string): Promise<number> {
    sequence += 1;
    const project = await ok('create_project', { name: `e2e ${label} ${sequence}` });
    return project.id as number;
  }

  async function createTask(projectId: number, title: string): Promise<number> {
    const task = await ok('create_task', { title, project_id: projectId, created_by: 'e2e' });
    return task.id as number;
  }

  async function finish(taskId: number): Promise<void> {
    await ok('update_task', { id: taskId, updates: { status: 'in_progress' } });
    await ok('update_task', { id: taskId, updates: { status: 'done' } });
  }

  async function listedProjectIds(): Promise<number[]> {
    const listed = await ok('list_projects', {});
    return ((listed.projects ?? []) as Array<{ id: number }>).map((project) => project.id);
  }

  /** The audit trail is written in onResponse; poll until the rows land. */
  async function auditRowsFor(projectId: number, expected: number): Promise<AuditEventRow[]> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = app.auditEventRepository.findByResource('projects', String(projectId), 20);
      if (rows.length >= expected) {
        return rows;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return app.auditEventRepository.findByResource('projects', String(projectId), 20);
  }

  it('archive → list_projects omits it → create_task rejected → unarchive → create_task succeeds', async () => {
    const projectId = await createProject('round trip');
    await finish(await createTask(projectId, 'the only task'));
    expect(await listedProjectIds()).toContain(projectId);

    // Every task is done, so no force is needed.
    const archived = await ok('archive_project', { id: projectId });
    expect(archived).toMatchObject({ id: projectId, archived: true, archived_by: 'e2e-archiver' });

    expect(await listedProjectIds()).not.toContain(projectId);
    const onlyArchived = await ok('list_projects', { archived: 'only' });
    expect((onlyArchived.projects as Array<{ id: number }>).map((p) => p.id)).toContain(projectId);

    const refused = await call(remote, 'create_task', {
      title: 'refused',
      project_id: projectId,
      created_by: 'e2e',
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe(
      `MCP error -32600: project_archived: project ${projectId} is archived and read-only; unarchive it before making changes`,
    );

    const unarchived = await ok('unarchive_project', { id: projectId });
    expect(unarchived).toMatchObject({ id: projectId, archived: false, archived_at: null });
    expect(await listedProjectIds()).toContain(projectId);

    const created = await ok('create_task', {
      title: 'accepted again',
      project_id: projectId,
      created_by: 'e2e',
    });
    expect(created).toMatchObject({ project_id: projectId, title: 'accepted again' });
  });

  it('archive and unarchive through the bridge each write a REST audit row on the project', async () => {
    const projectId = await createProject('audited');
    await ok('archive_project', { id: projectId, force: true, reason: 'audit check' });
    await ok('unarchive_project', { id: projectId });

    const rows = await auditRowsFor(projectId, 2);
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'POST /api/v1/projects/:id/archive',
        'POST /api/v1/projects/:id/unarchive',
      ]),
    );
    for (const row of rows.filter((r) => r.action.endsWith('archive'))) {
      expect(row.resource_type).toBe('projects');
      expect(row.resource_id).toBe(String(projectId));
    }
  });

  it('force without a reason is refused with the code archive_reason_required and archives nothing', async () => {
    const projectId = await createProject('no reason');
    await createTask(projectId, 'unfinished');

    const viaRemote = await call(remote, 'archive_project', { id: projectId, force: true });
    expect(viaRemote.isError).toBe(true);
    expect(text(viaRemote)).toContain('archive_reason_required');

    // The REST route behind the bridge asserts the same code in its body.
    const res = await fetch(`${baseUrl}/api/v1/projects/${String(projectId)}/archive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/archive_reason_required/);

    const project = await ok('get_project', { id: projectId });
    expect(project.archived).toBe(false);
    expect(await listedProjectIds()).toContain(projectId);
  });

  it('a stdio unarchive re-evaluates the project; the bridge then sees the dependent open', async () => {
    const liveId = await createProject('live blockers');
    const projectId = await createProject('comes back');
    const blockerId = await createTask(liveId, 'blocker');
    const dependentId = await createTask(projectId, 'dependent');
    await ok('update_task', {
      id: dependentId,
      updates: { status: 'blocked', blocked_by: [blockerId] },
    });

    await ok('archive_project', { id: projectId, force: true, reason: 'paused' });
    // The blocker finishes while the dependent's project is frozen, so the
    // workflow engine cannot unblock it yet.
    await finish(blockerId);
    expect((await ok('get_task', { id: dependentId })).status).toBe('blocked');

    const unarchived = await call(stdio, 'unarchive_project', { id: projectId });
    expect(unarchived.isError).toBeFalsy();

    expect((await ok('get_task', { id: dependentId })).status).toBe('open');
  });

  it('a task whose re-evaluation fails is named by unarchive_project on both transports (WFT #2542)', async () => {
    const liveId = await createProject('partial live');
    const projectId = await createProject('partial');
    const blockerId = await createTask(liveId, 'blocker');
    const failingId = await createTask(projectId, 'failing dependent');
    await ok('update_task', {
      id: failingId,
      updates: { status: 'blocked', blocked_by: [blockerId] },
    });
    await ok('archive_project', { id: projectId, force: true, reason: 'paused' });
    await finish(blockerId);

    // Fault injection only: the write of one task fails inside the server.
    const original = app.taskService.updateTask.bind(app.taskService);
    const spy = vi
      .spyOn(app.taskService, 'updateTask')
      .mockImplementation((taskId: number, ...rest: unknown[]) => {
        if (taskId === failingId) {
          throw new Error(`simulated write failure on task ${taskId}`);
        }
        return (original as (...args: unknown[]) => ReturnType<typeof original>)(taskId, ...rest);
      });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The real unarchive through the bridge (REST underneath)...
      const viaRemote = await call(remote, 'unarchive_project', { id: projectId });
      expect(viaRemote.isError).toBeFalsy();
      expect(viaRemote.structuredContent).toMatchObject({
        id: projectId,
        archived: false,
        reevaluation_failed_task_ids: [failingId],
      });
      expect(text(viaRemote)).toContain(`re-evaluation failed for task ${failingId}`);

      // ...and the repeated (retry) unarchive on stdio, still failing.
      const viaStdio = await call(stdio, 'unarchive_project', { id: projectId });
      expect(viaStdio.isError).toBeFalsy();
      expect(viaStdio.structuredContent).toMatchObject({
        id: projectId,
        reevaluation_failed_task_ids: [failingId],
      });
      expect(text(viaStdio)).toContain(`re-evaluation failed for task ${failingId}`);
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }

    const retried = await call(remote, 'unarchive_project', { id: projectId });
    expect(retried.structuredContent).toMatchObject({ reevaluation_failed_task_ids: [] });
    expect(text(retried)).not.toContain('re-evaluation failed');
    expect((await ok('get_task', { id: failingId })).status).toBe('open');
  });
});
