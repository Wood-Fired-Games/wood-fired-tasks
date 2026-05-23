/**
 * Tests for Phase 31 Plan 03 Task 2 — MCP tool handlers inject the boot-
 * resolved actor user.id into service-write input objects.
 *
 * These tests are in a separate file from `task-tools.test.ts` because they
 * need a server constructed with a non-default `McpServerContext`. The
 * existing file uses the default `{ actorUserId: null }` context, which is
 * appropriate for testing the pre-Phase-31 tool surface; this file pivots
 * on the new ctx wiring.
 *
 * Assertion shape mirrors the REST route tests in 31-02: end-to-end through
 * the InMemoryTransport client, then read back the row from the DB via the
 * raw better-sqlite3 handle so the parallel FK columns are inspected
 * directly (not via the service projection which hides them today).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface TaskRow {
  id: number;
  title: string;
  created_by: string;
  created_by_user_id: number | null;
  assignee: string | null;
  assignee_user_id: number | null;
}

interface CommentRow {
  id: number;
  task_id: number;
  author: string;
  author_user_id: number | null;
  content: string;
}

describe('MCP tool handlers inject ctx.actorUserId into service writes', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;
  let mcpBotUserId: number;

  // A distinct user.id (NOT mcp-bot) used to prove the handlers thread
  // whatever ctx.actorUserId they're given, not a hard-coded fallback.
  let testActorUserId: number;

  beforeEach(async () => {
    app = await createTestApp();

    const project = app.projectService.createProject({ name: 'Test Project' });
    testProjectId = project.id;

    // Seed an additional non-service-account user so the actor injection
    // test can prove the handler used ctx.actorUserId (not mcp-bot).
    const insertUser = app.db
      .prepare(
        `INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`,
      )
      .get('mcp-actor-test', 'mcp-actor@example.com') as { id: number };
    testActorUserId = insertUser.id;

    // Verify mcp-bot is seeded (sanity for the fallback paths in other
    // tests; we don't use it for the positive case below).
    const bot = app.userRepository.findServiceAccountByName('mcp-bot');
    expect(bot).not.toBeNull();
    mcpBotUserId = bot!.id;
    expect(mcpBotUserId).not.toBe(testActorUserId);

    // Construct the MCP server with the per-test actor.
    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      { actorUserId: testActorUserId, userRepository: app.userRepository },
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  function readTaskRow(id: number): TaskRow {
    return app.db
      .prepare(
        `SELECT id, title, created_by, created_by_user_id, assignee, assignee_user_id
         FROM tasks WHERE id = ?`,
      )
      .get(id) as TaskRow;
  }

  function readCommentRow(id: number): CommentRow {
    return app.db
      .prepare(
        `SELECT id, task_id, author, author_user_id, content
         FROM task_comments WHERE id = ?`,
      )
      .get(id) as CommentRow;
  }

  describe('create_task', () => {
    it('writes created_by_user_id from ctx.actorUserId', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Task with actor FK',
          project_id: testProjectId,
          created_by: 'mcp-actor-test',
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const created = result.structuredContent as { id: number };
      expect(created.id).toBeDefined();

      const row = readTaskRow(created.id);
      // Legacy TEXT column unchanged.
      expect(row.created_by).toBe('mcp-actor-test');
      // NEW: parallel FK column populated from ctx.actorUserId.
      expect(row.created_by_user_id).toBe(testActorUserId);
    });

    it('does not let a client-supplied created_by_user_id override ctx.actorUserId (T-31-07)', async () => {
      // Simulate a JSON-RPC client that tries to spoof the FK directly.
      // The handler must IGNORE the body-supplied value and use ctx.actorUserId.
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Spoof attempt',
          project_id: testProjectId,
          created_by: 'mcp-actor-test',
          created_by_user_id: 999999, // non-existent + clearly different
        },
      })) as ToolResult;

      // If the schema accepted the spoofed field (it does, by Plan 01
      // design — the field is on the service schema so the route/tool can
      // pass through server-derived values), the handler must overwrite it
      // before the service call.
      expect(result.isError).toBeFalsy();
      const created = result.structuredContent as { id: number };
      const row = readTaskRow(created.id);
      expect(row.created_by_user_id).toBe(testActorUserId);
      expect(row.created_by_user_id).not.toBe(999999);
    });
  });

  describe('claim_task', () => {
    it('writes assignee_user_id from ctx.actorUserId on claim', async () => {
      // Create an unclaimed task.
      const task = app.taskService.createTask({
        title: 'Claimable',
        project_id: testProjectId,
        created_by: 'creator',
      });

      const result = (await client.callTool({
        name: 'claim_task',
        arguments: { task_id: task.id, assignee: 'mcp-actor-test' },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();

      const row = readTaskRow(task.id);
      // Legacy TEXT assignee from the tool arg.
      expect(row.assignee).toBe('mcp-actor-test');
      // NEW: parallel FK from ctx.actorUserId.
      expect(row.assignee_user_id).toBe(testActorUserId);
    });
  });

  describe('update_task assignee resolution', () => {
    it('resolves assignee_user_id from an email-shaped assignee that matches a user', async () => {
      // Create a task to update.
      const task = app.taskService.createTask({
        title: 'To-be-assigned',
        project_id: testProjectId,
        created_by: 'creator',
      });

      // Insert a user with a known email so the email-resolution branch hits.
      const target = app.db
        .prepare(
          `INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`,
        )
        .get('Bob', 'bob@example.com') as { id: number };

      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: task.id,
          updates: { assignee: 'bob@example.com' },
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const row = readTaskRow(task.id);
      expect(row.assignee).toBe('bob@example.com');
      expect(row.assignee_user_id).toBe(target.id);
    });

    it('leaves assignee_user_id NULL when assignee is a free-form string with no email shape', async () => {
      const task = app.taskService.createTask({
        title: 'Free-form assignee',
        project_id: testProjectId,
        created_by: 'creator',
      });

      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: task.id,
          updates: { assignee: 'Some Free Form Name' },
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const row = readTaskRow(task.id);
      expect(row.assignee).toBe('Some Free Form Name');
      expect(row.assignee_user_id).toBeNull();
    });

    it('clears assignee_user_id to NULL when assignee is set to null', async () => {
      // Create a task with an assignee + FK already populated.
      const task = app.taskService.createTask({
        title: 'Pre-assigned',
        project_id: testProjectId,
        created_by: 'creator',
        assignee: 'previous@example.com',
        assignee_user_id: testActorUserId,
      });

      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: task.id,
          updates: { assignee: null },
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const row = readTaskRow(task.id);
      expect(row.assignee).toBeNull();
      expect(row.assignee_user_id).toBeNull();
    });

    it('leaves assignee_user_id untouched when the update does not mention assignee', async () => {
      const task = app.taskService.createTask({
        title: 'Stable assignee',
        project_id: testProjectId,
        created_by: 'creator',
        assignee: 'kept@example.com',
        assignee_user_id: testActorUserId,
      });

      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: task.id,
          updates: { priority: 'high' },
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const row = readTaskRow(task.id);
      expect(row.assignee).toBe('kept@example.com');
      expect(row.assignee_user_id).toBe(testActorUserId);
    });
  });

  describe('add_comment', () => {
    it('writes author_user_id from ctx.actorUserId', async () => {
      const task = app.taskService.createTask({
        title: 'Commentable',
        project_id: testProjectId,
        created_by: 'creator',
      });

      const result = (await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: task.id,
          author: 'mcp-actor-test',
          content: 'first comment',
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as { comment: { id: number } };
      const row = readCommentRow(sc.comment.id);
      expect(row.author).toBe('mcp-actor-test');
      expect(row.author_user_id).toBe(testActorUserId);
    });
  });
});

describe('MCP tool handlers with default ctx (no actor)', () => {
  // Verifies the back-compat default: when createMcpServer is called
  // without an explicit ctx (or with actorUserId: null), the FK column is
  // written as NULL. This preserves the pre-Phase-31 behaviour for
  // existing tests that don't care about identity.
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    const project = app.projectService.createProject({ name: 'Test Project' });
    testProjectId = project.id;

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      // No ctx → default { actorUserId: null }.
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  it('leaves created_by_user_id NULL when ctx is default', async () => {
    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'No-actor task',
        project_id: testProjectId,
        created_by: 'someone',
      },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const created = result.structuredContent as { id: number };
    const row = app.db
      .prepare(
        `SELECT created_by_user_id FROM tasks WHERE id = ?`,
      )
      .get(created.id) as { created_by_user_id: number | null };
    expect(row.created_by_user_id).toBeNull();
  });
});
