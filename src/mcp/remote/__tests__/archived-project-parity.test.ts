import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../../api/server.js';
import type { App } from '../../../index.js';
import { createMcpServer } from '../../server.js';
import { RestClient } from '../rest-client.js';
import { registerRemoteTools } from '../register-tools.js';
import { seedAuth } from '../../../api/__tests__/helpers/auth.js';

/**
 * Archived project state through the remote bridge (WFT #2476, design §3.5).
 *
 * Production reaches MCP through the remote bridge, so every archive
 * behaviour is driven here through the REAL pipe: MCP client → the tools
 * `registerRemoteTools` registers → `RestClient` → a real Fastify server on a
 * loopback port. A stdio MCP server over the SAME app runs beside it, so a
 * refusal can be compared between the two transports on the same row.
 */

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('remote MCP: archived project state (stdio parity)', () => {
  let server: FastifyInstance;
  let app: App;
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
    const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    const { token } = seedAuth(app.db, { displayName: 'remote-archiver' });

    const remoteServer = new McpServer({ name: 'remote-under-test', version: '1.0.0' });
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

  let projectId: number;
  let taskId: number;
  let otherTaskId: number;

  beforeEach(() => {
    sequence += 1;
    projectId = app.projectService.createProject({ name: `Remote archive ${sequence}` }).id;
    taskId = app.taskService.createTask({
      title: `task-${sequence}-a`,
      project_id: projectId,
      created_by: 'tester',
    }).id;
    otherTaskId = app.taskService.createTask({
      title: `task-${sequence}-b`,
      project_id: projectId,
      created_by: 'tester',
    }).id;
  });

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  function text(result: ToolResult): string {
    return result.content[0]?.text ?? '';
  }

  function forceArchive(): void {
    app.projectService.archiveProject(projectId, { force: true, reason: 'shelved' }, 'tester');
  }

  function taskIds(result: ToolResult): number[] {
    const tasks = (result.structuredContent?.tasks ?? []) as Array<{ id: number }>;
    return tasks.map((task) => task.id).sort((a, b) => a - b);
  }

  function projectIds(result: ToolResult): number[] {
    const projects = (result.structuredContent?.projects ?? []) as Array<{ id: number }>;
    return projects.map((project) => project.id);
  }

  describe('archive_project and unarchive_project', () => {
    it('refuses while tasks are unfinished, with the same error class and code as stdio', async () => {
      const viaRemote = await call(remote, 'archive_project', { id: projectId });
      const viaStdio = await call(stdio, 'archive_project', { id: projectId });

      expect(viaRemote.isError).toBe(true);
      expect(text(viaRemote)).toMatch(/^MCP error -32600: project_has_unfinished_tasks: /);
      expect(text(viaRemote)).toBe(text(viaStdio));
      expect(app.projectService.getProject(projectId).archived).toBe(false);
    });

    it('archives with force and a reason; archived_by is the token owner; unarchive restores it', async () => {
      const archived = await call(remote, 'archive_project', {
        id: projectId,
        force: true,
        reason: 'shelved',
      });

      expect(archived.isError).toBeFalsy();
      expect(text(archived)).toBe(`Project ${projectId} archived: Remote archive ${sequence}`);
      expect(archived.structuredContent).toMatchObject({
        id: projectId,
        archived: true,
        archived_by: 'remote-archiver',
        archive_reason: 'shelved',
      });

      const shown = await call(remote, 'get_project', { id: projectId });
      expect(text(shown)).toMatch(/Archived: \S+ by remote-archiver \(reason: shelved\)/);
      expect(text(shown)).toBe(text(await call(stdio, 'get_project', { id: projectId })));

      const unarchived = await call(remote, 'unarchive_project', { id: projectId });
      expect(unarchived.isError).toBeFalsy();
      expect(text(unarchived)).toBe(`Project ${projectId} unarchived: Remote archive ${sequence}`);
      expect(unarchived.structuredContent).toMatchObject({ archived: false, archived_at: null });
      expect(app.projectService.getProject(projectId).archived).toBe(false);
    });

    it('force without a reason is refused and archives nothing', async () => {
      const result = await call(remote, 'archive_project', { id: projectId, force: true });

      expect(result.isError).toBe(true);
      expect(app.projectService.getProject(projectId).archived).toBe(false);
    });
  });

  describe('the freeze refusal', () => {
    const writes: Array<{ tool: string; args: () => Record<string, unknown> }> = [
      {
        tool: 'create_task',
        args: () => ({ title: 'nope', project_id: projectId, created_by: 'tester' }),
      },
      { tool: 'update_task', args: () => ({ id: taskId, updates: { priority: 'high' } }) },
      { tool: 'claim_task', args: () => ({ task_id: taskId, assignee: 'agent' }) },
      { tool: 'delete_task', args: () => ({ id: taskId }) },
      { tool: 'update_project', args: () => ({ id: projectId, updates: { name: 'renamed' } }) },
      { tool: 'add_dependency', args: () => ({ task_id: taskId, blocks_task_id: otherTaskId }) },
      { tool: 'rescore_project', args: () => ({ project_id: projectId, submissions: [] }) },
    ];

    it.each(writes)(
      '$tool reaches remote MCP as the same InvalidRequest project_archived error as stdio',
      async ({ tool, args }) => {
        forceArchive();
        const before = app.taskService.getTask(taskId);

        const viaRemote = await call(remote, tool, args());
        const viaStdio = await call(stdio, tool, args());

        expect(viaRemote.isError).toBe(true);
        // -32600 is InvalidRequest; the stable code opens the message.
        expect(text(viaRemote)).toBe(
          `MCP error -32600: project_archived: project ${projectId} is archived and read-only; unarchive it before making changes`,
        );
        expect(text(viaRemote)).toBe(text(viaStdio));
        expect(app.taskService.getTask(taskId)).toEqual(before);
      },
    );

    it('a comment is still allowed on a task in an archived project', async () => {
      forceArchive();

      const result = await call(remote, 'add_comment', {
        task_id: taskId,
        author: 'tester',
        content: 'regression tracked elsewhere',
      });

      expect(result.isError).toBeFalsy();
    });

    it('the same write succeeds again after unarchive_project', async () => {
      forceArchive();
      await call(remote, 'unarchive_project', { id: projectId });

      const result = await call(remote, 'update_task', {
        id: taskId,
        updates: { priority: 'high' },
      });

      expect(result.isError).toBeFalsy();
      expect(app.taskService.getTask(taskId).priority).toBe('high');
    });
  });

  describe('list_projects', () => {
    it('applies each archived value exactly as stdio does', async () => {
      forceArchive();
      const liveId = app.projectService.createProject({ name: `Remote live ${sequence}` }).id;

      for (const archived of [undefined, 'exclude', 'include', 'only'] as const) {
        const args = { limit: 500, ...(archived === undefined ? {} : { archived }) };
        const viaRemote = await call(remote, 'list_projects', args);
        const viaStdio = await call(stdio, 'list_projects', args);
        const ids = projectIds(viaRemote);

        expect(ids.includes(projectId), `archived=${archived} archived project`).toBe(
          archived === 'include' || archived === 'only',
        );
        expect(ids.includes(liveId), `archived=${archived} live project`).toBe(archived !== 'only');
        expect(ids).toEqual(projectIds(viaStdio));
        expect(viaRemote.structuredContent?.total).toBe(viaStdio.structuredContent?.total);
        expect(text(viaRemote)).toBe(text(viaStdio));
      }
    });
  });

  describe('list_tasks', () => {
    it('project_id of an archived project returns its tasks with archived=only', async () => {
      forceArchive();

      const result = await call(remote, 'list_tasks', { project_id: projectId, archived: 'only' });

      expect(taskIds(result)).toEqual([taskId, otherTaskId]);
      expect(result.structuredContent?.total).toBe(2);
    });

    it('project_id of an archived project returns its tasks with archived=include', async () => {
      forceArchive();

      const result = await call(remote, 'list_tasks', {
        project_id: projectId,
        archived: 'include',
      });

      expect(taskIds(result)).toEqual([taskId, otherTaskId]);
      expect(result.structuredContent?.total).toBe(2);
    });

    it('project_id of an archived project returns its tasks with no archived value and with exclude', async () => {
      forceArchive();

      for (const args of [
        { project_id: projectId },
        { project_id: projectId, archived: 'exclude' },
      ]) {
        const result = await call(remote, 'list_tasks', args);
        expect(taskIds(result)).toEqual([taskId, otherTaskId]);
      }
    });

    it('without project_id the archived value decides, exactly as on stdio', async () => {
      forceArchive();
      const liveProjectId = app.projectService.createProject({
        name: `Remote live tasks ${sequence}`,
      }).id;
      const liveTaskId = app.taskService.createTask({
        title: `live-${sequence}`,
        project_id: liveProjectId,
        created_by: 'tester',
      }).id;

      for (const archived of [undefined, 'exclude', 'include', 'only'] as const) {
        const args = { limit: 500, ...(archived === undefined ? {} : { archived }) };
        const viaRemote = await call(remote, 'list_tasks', args);
        const viaStdio = await call(stdio, 'list_tasks', args);
        const ids = taskIds(viaRemote);

        expect(ids.includes(taskId), `archived=${archived} archived task`).toBe(
          archived === 'include' || archived === 'only',
        );
        expect(ids.includes(liveTaskId), `archived=${archived} live task`).toBe(
          archived !== 'only',
        );
        expect(ids).toEqual(taskIds(viaStdio));
        expect(viaRemote.structuredContent?.total).toBe(viaStdio.structuredContent?.total);
      }
    });
  });

  describe('check_health', () => {
    it('carries the same archived_projects count as stdio', async () => {
      forceArchive();
      const expected = app.projectService.listProjects({ archived: 'only', limit: 500 }).length;

      const viaRemote = await call(remote, 'check_health', {});
      const viaStdio = await call(stdio, 'check_health', {});

      const remoteDb = viaRemote.structuredContent?.database as { archived_projects: number };
      const stdioDb = viaStdio.structuredContent?.database as { archived_projects: number };
      expect(remoteDb.archived_projects).toBe(expected);
      expect(stdioDb.archived_projects).toBe(expected);
      expect(text(viaRemote)).toContain(`Archived Projects: ${expected}`);
    });
  });
});
