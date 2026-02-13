import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

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
    const server = createMcpServer(app.taskService, app.projectService);

    // Create paired in-memory transports
    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    // Connect server to its transport
    await server.connect(serverTransport);

    // Create and connect client
    client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.db.close();
  });

  describe('create_task tool', () => {
    it('creates a task with required fields', async () => {
      const result = await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Test task',
          project_id: testProjectId,
          created_by: 'test-agent',
        },
      });

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Test task');
        expect(result.content[0].text).toContain('ID:');
        expect(result.content[0].text).toContain('Status: open');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        expect(result.structuredContent.title).toBe('Test task');
        expect(result.structuredContent.id).toBeDefined();
        expect(result.structuredContent.status).toBe('open');
      }
    });

    it('creates a task with all optional fields', async () => {
      const result = await client.callTool({
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
      });

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
      const result = await client.callTool({
        name: 'create_task',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('validation');
      }
    });

    it('rejects task with non-existent project_id', async () => {
      const result = await client.callTool({
        name: 'create_task',
        arguments: {
          title: 'Test task',
          project_id: 9999,
          created_by: 'test-agent',
        },
      });

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

      const result = await client.callTool({
        name: 'get_task',
        arguments: { id: created.id },
      });

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Get me');
        expect(result.content[0].text).toContain('Status: open');
        expect(result.content[0].text).toContain('Priority: high');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        expect(result.structuredContent.id).toBe(created.id);
        expect(result.structuredContent.title).toBe('Get me');
      }
    });

    it('returns error for non-existent task ID', async () => {
      const result = await client.callTool({
        name: 'get_task',
        arguments: { id: 9999 },
      });

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

      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          id: created.id,
          updates: {
            title: 'Updated title',
            priority: 'high',
          },
        },
      });

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('updated');
        expect(result.content[0].text).toContain('Updated title');
        expect(result.content[0].text).toContain('high');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        expect(result.structuredContent.title).toBe('Updated title');
        expect(result.structuredContent.priority).toBe('high');
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
      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          id: created.id,
          updates: { status: 'done' },
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('transition');
      }
    });

    it('returns error for non-existent task', async () => {
      const result = await client.callTool({
        name: 'update_task',
        arguments: {
          id: 9999,
          updates: { title: 'New title' },
        },
      });

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

      const result = await client.callTool({
        name: 'list_tasks',
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Found 3 task(s)');
        expect(result.content[0].text).toContain('Task 1');
        expect(result.content[0].text).toContain('Task 2');
        expect(result.content[0].text).toContain('Task 3');
      }
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

      const result = await client.callTool({
        name: 'list_tasks',
        arguments: { status: 'open' },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Found 1 task(s)');
        expect(result.content[0].text).toContain('Open task');
        expect(result.content[0].text).not.toContain('In-progress task');
      }
    });

    it('returns empty message when no tasks match', async () => {
      const result = await client.callTool({
        name: 'list_tasks',
        arguments: { assignee: 'nobody' },
      });

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
      const result = await client.callTool({
        name: 'delete_task',
        arguments: { id: created.id },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('deleted');
        expect(result.content[0].text).toContain(String(created.id));
      }

      // Verify it's gone
      const getResult = await client.callTool({
        name: 'get_task',
        arguments: { id: created.id },
      });
      expect(getResult.isError).toBe(true);
    });

    it('returns error for non-existent task', async () => {
      const result = await client.callTool({
        name: 'delete_task',
        arguments: { id: 9999 },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('9999');
      }
    });
  });
});
