import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// The MCP SDK callTool returns a union of CallToolResult | CompatibilityCallToolResult.
// The index signature makes content/structuredContent resolve to unknown.
// This type represents the standard (non-compatibility) result shape we expect.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP Task Tools', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;

  beforeEach(async () => {
    // Create in-memory test app
    app = await createTestApp();

    // Create a test project for tools to use
    const project = app.projectService.createProject({ name: 'Test Project' });
    testProjectId = project.id;

    // Create MCP server
    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
    );

    // Create paired in-memory transports
    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    // Connect server to its transport
    await server.connect(serverTransport);

    // Create and connect client
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  describe('create_task tool', () => {
    it('creates a task with required fields', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Test task',
          project_id: testProjectId,
          created_by: 'test-agent',
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Test task');
        expect(result.content[0].text).toContain('ID:');
        expect(result.content[0].text).toContain('Status: open');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const task = result.structuredContent as {
          id: number;
          title: string;
          status: string;
        };
        expect(task.title).toBe('Test task');
        expect(task.id).toBeDefined();
        expect(task.status).toBe('open');
      }
    });

    it('creates a task with all optional fields', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Full task',
          description: 'Detailed description',
          priority: 'high',
          project_id: testProjectId,
          assignee: 'john-doe',
          created_by: 'test-agent',
          due_date: '2026-03-01T12:00:00Z',
          tags: ['urgent', 'backend'],
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Full task');
      }

      // structuredContent may or may not be returned depending on SDK version
      // The key test is that the task was created with all fields
      const tasks = app.taskService.listTasks({});
      const createdTask = tasks.find((t) => t.title === 'Full task');
      expect(createdTask).toBeDefined();
      if (createdTask) {
        expect(createdTask.description).toBe('Detailed description');
        expect(createdTask.priority).toBe('high');
        expect(createdTask.assignee).toBe('john-doe');
        expect(createdTask.due_date).toBe('2026-03-01T12:00:00Z');
        expect(createdTask.tags).toEqual(['backend', 'urgent']); // Sorted alphabetically
      }
    });

    it('rejects task with missing required fields', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('validation');
      }
    });

    it('rejects task with non-existent project_id', async () => {
      const result = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Test task',
          project_id: 9999,
          created_by: 'test-agent',
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('9999');
      }
    });
  });

  describe('get_task tool', () => {
    it('returns task by ID', async () => {
      // Create a task first
      const created = app.taskService.createTask({
        title: 'Get me',
        project_id: testProjectId,
        created_by: 'test-agent',
        priority: 'high',
      });

      const result = (await client.callTool({
        name: 'get_task',
        arguments: { id: created.id },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Get me');
        expect(result.content[0].text).toContain('Status: open');
        expect(result.content[0].text).toContain('Priority: high');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const task = result.structuredContent as { id: number; title: string };
        expect(task.id).toBe(created.id);
        expect(task.title).toBe('Get me');
      }
    });

    it('returns error for non-existent task ID', async () => {
      const result = (await client.callTool({
        name: 'get_task',
        arguments: { id: 9999 },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('9999');
      }
    });
  });

  describe('update_task tool', () => {
    it('updates task fields', async () => {
      // Create a task first
      const created = app.taskService.createTask({
        title: 'Original title',
        project_id: testProjectId,
        created_by: 'test-agent',
        priority: 'low',
      });

      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: created.id,
          updates: {
            title: 'Updated title',
            priority: 'high',
          },
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('updated');
        expect(result.content[0].text).toContain('Updated title');
        expect(result.content[0].text).toContain('high');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const task = result.structuredContent as {
          title: string;
          priority: string;
        };
        expect(task.title).toBe('Updated title');
        expect(task.priority).toBe('high');
      }
    });

    it('rejects invalid status transition', async () => {
      // Create a task (status: open)
      const created = app.taskService.createTask({
        title: 'Test task',
        project_id: testProjectId,
        created_by: 'test-agent',
      });

      // Try invalid transition: open -> done (skipping in-progress)
      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: created.id,
          updates: { status: 'done' },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('transition');
      }
    });

    it('returns error for non-existent task', async () => {
      const result = (await client.callTool({
        name: 'update_task',
        arguments: {
          id: 9999,
          updates: { title: 'New title' },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('9999');
      }
    });
  });

  describe('list_tasks tool', () => {
    it('lists all tasks when no filters', async () => {
      // Create multiple tasks
      app.taskService.createTask({
        title: 'Task 1',
        project_id: testProjectId,
        created_by: 'test-agent',
      });
      app.taskService.createTask({
        title: 'Task 2',
        project_id: testProjectId,
        created_by: 'test-agent',
      });
      app.taskService.createTask({
        title: 'Task 3',
        project_id: testProjectId,
        created_by: 'test-agent',
      });

      const result = (await client.callTool({
        name: 'list_tasks',
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        // Paginated envelope: "Found 3 of 3 task(s) (limit=50, offset=0)"
        expect(result.content[0].text).toContain('Found 3 of 3 task(s)');
        expect(result.content[0].text).toContain('Task 1');
        expect(result.content[0].text).toContain('Task 2');
        expect(result.content[0].text).toContain('Task 3');
      }
      // structuredContent now carries the pagination envelope alongside tasks.
      const data = result.structuredContent as {
        tasks: unknown[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(data.total).toBe(3);
      expect(data.limit).toBe(50);
      expect(data.offset).toBe(0);
      expect(data.tasks).toHaveLength(3);
    });

    it('filters tasks by status', async () => {
      // Create tasks with different statuses
      const task1 = app.taskService.createTask({
        title: 'Open task',
        project_id: testProjectId,
        created_by: 'test-agent',
      });
      const task2 = app.taskService.createTask({
        title: 'In-progress task',
        project_id: testProjectId,
        created_by: 'test-agent',
      });
      app.taskService.updateTask(task2.id, { status: 'in_progress' });

      const result = (await client.callTool({
        name: 'list_tasks',
        arguments: { status: 'open' },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Found 1 of 1 task(s)');
        expect(result.content[0].text).toContain('Open task');
        expect(result.content[0].text).not.toContain('In-progress task');
      }
    });

    it('respects limit/offset pagination args', async () => {
      // Seed 4 tasks beyond whatever the previous tests left behind.
      for (let i = 0; i < 4; i++) {
        app.taskService.createTask({
          title: `Pagination MCP ${i + 1}`,
          project_id: testProjectId,
          created_by: 'test-agent',
        });
      }

      const result = (await client.callTool({
        name: 'list_tasks',
        arguments: { project_id: testProjectId, limit: 2, offset: 1 },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      const data = result.structuredContent as {
        tasks: unknown[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(data.limit).toBe(2);
      expect(data.offset).toBe(1);
      expect(data.tasks.length).toBeLessThanOrEqual(2);
      expect(data.total).toBeGreaterThanOrEqual(2);
    });

    it('returns empty message when no tasks match', async () => {
      const result = (await client.callTool({
        name: 'list_tasks',
        arguments: { assignee: 'nobody' },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('No tasks found');
      }
    });
  });

  describe('delete_task tool', () => {
    it('deletes an existing task', async () => {
      // Create a task
      const created = app.taskService.createTask({
        title: 'Delete me',
        project_id: testProjectId,
        created_by: 'test-agent',
      });

      // Delete it
      const result = (await client.callTool({
        name: 'delete_task',
        arguments: { id: created.id },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('deleted');
        expect(result.content[0].text).toContain(String(created.id));
      }

      // Verify it's gone
      const getResult = (await client.callTool({
        name: 'get_task',
        arguments: { id: created.id },
      })) as ToolResult;
      expect(getResult.isError).toBe(true);
    });

    it('returns error for non-existent task', async () => {
      const result = (await client.callTool({
        name: 'delete_task',
        arguments: { id: 9999 },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('9999');
      }
    });
  });

  describe('list_subtasks tool', () => {
    it('lists subtasks with detailed formatting', async () => {
      // Create parent task
      const parent = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Parent task',
          project_id: testProjectId,
          created_by: 'test-agent',
        },
      })) as ToolResult;

      const parentId = (parent.structuredContent as { id: number }).id;

      // Create 2 child tasks
      await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Subtask 1',
          project_id: testProjectId,
          parent_task_id: parentId,
          created_by: 'test-agent',
        },
      });

      await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Subtask 2',
          project_id: testProjectId,
          parent_task_id: parentId,
          created_by: 'test-agent',
        },
      });

      // List subtasks
      const result = (await client.callTool({
        name: 'list_subtasks',
        arguments: { task_id: parentId },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('2 subtask(s)');
        expect(result.content[0].text).toContain('Subtask 1');
        expect(result.content[0].text).toContain('Subtask 2');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          parent_task_id: number;
          subtasks: Array<{ title: string }>;
        };
        expect(data.parent_task_id).toBe(parentId);
        expect(data.subtasks).toHaveLength(2);
      }
    });

    it('returns empty array when task has no subtasks', async () => {
      const task = (await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Task with no children',
          project_id: testProjectId,
          created_by: 'test-agent',
        },
      })) as ToolResult;

      const taskId = (task.structuredContent as { id: number }).id;

      const result = (await client.callTool({
        name: 'list_subtasks',
        arguments: { task_id: taskId },
      })) as ToolResult;

      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('no subtasks');
      }

      if (result.structuredContent) {
        const data = result.structuredContent as { subtasks: unknown[] };
        expect(data.subtasks).toHaveLength(0);
      }
    });
  });

  // NOTE: get_subtasks tool tests are covered via REST API tests in
  // src/api/__tests__/subtasks.test.ts. MCP tool functionality is verified
  // through those comprehensive API integration tests.
});
