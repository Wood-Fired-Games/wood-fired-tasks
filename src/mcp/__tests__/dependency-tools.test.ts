import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

// The MCP SDK callTool returns a union of CallToolResult | CompatibilityCallToolResult.
// The index signature makes content/structuredContent resolve to unknown.
// This type represents the standard (non-compatibility) result shape we expect.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP Dependency Tools', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;
  let task1Id: number;
  let task2Id: number;
  let task3Id: number;

  beforeEach(async () => {
    // Create in-memory test app
    app = await createTestApp();

    // Create a test project for tools to use
    const project = app.projectService.createProject({ name: 'Test Project' });
    testProjectId = project.id;

    // Create test tasks for dependency tests
    const task1 = app.taskService.createTask({
      title: 'Task 1',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    task1Id = task1.id;

    const task2 = app.taskService.createTask({
      title: 'Task 2',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    task2Id = task2.id;

    const task3 = app.taskService.createTask({
      title: 'Task 3',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    task3Id = task3.id;

    // Create MCP server
    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db
    );

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
    app.dispose();
  });

  describe('add_dependency tool', () => {
    it('creates dependency between two tasks', async () => {
      const result = (await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Dependency created');
        expect(result.content[0].text).toContain(String(task1Id));
        expect(result.content[0].text).toContain(String(task2Id));
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          dependency: {
            id: number;
            task_id: number;
            blocks_task_id: number;
            created_at: string;
          };
        };
        expect(data.dependency.id).toBeDefined();
        expect(data.dependency.task_id).toBe(task1Id);
        expect(data.dependency.blocks_task_id).toBe(task2Id);
        expect(data.dependency.created_at).toBeDefined();
      }
    });

    it('returns error when task_id does not exist', async () => {
      const result = (await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: 9999,
          blocks_task_id: task2Id,
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });

    it('returns error when blocks_task_id does not exist', async () => {
      const result = (await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: 9999,
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });

    it('returns error for self-dependency', async () => {
      const result = (await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task1Id,
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });

    it('returns error for duplicate dependency', async () => {
      // Create first dependency
      await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      });

      // Try to create duplicate
      const result = (await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });

  describe('remove_dependency tool', () => {
    it('removes an existing dependency', async () => {
      // First create a dependency
      await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      });

      // Now remove it
      const result = (await client.callTool({
        name: 'remove_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('no longer blocks');
        expect(result.content[0].text).toContain(String(task1Id));
        expect(result.content[0].text).toContain(String(task2Id));
      }
    });

    it('returns error when dependency does not exist', async () => {
      const result = (await client.callTool({
        name: 'remove_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });

  describe('get_dependencies tool', () => {
    it('returns blocks and blocked_by for a task with dependencies', async () => {
      // Create dependencies: task1 blocks task2, task3 blocks task2
      await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      });

      await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task3Id,
          blocks_task_id: task2Id,
        },
      });

      // Get dependencies for task2
      const result = (await client.callTool({
        name: 'get_dependencies',
        arguments: { task_id: task2Id },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain(String(task2Id));
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          task_id: number;
          blocks: unknown[];
          blocked_by: Array<{ task_id: number }>;
        };
        expect(data.task_id).toBe(task2Id);
        expect(data.blocks).toHaveLength(0);
        expect(data.blocked_by).toHaveLength(2);
        // Verify both task1 and task3 are in blocked_by
        const blockerIds = data.blocked_by.map((d) => d.task_id);
        expect(blockerIds).toContain(task1Id);
        expect(blockerIds).toContain(task3Id);
      }
    });

    it('returns empty arrays for task with no dependencies', async () => {
      const result = (await client.callTool({
        name: 'get_dependencies',
        arguments: { task_id: task1Id },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain(String(task1Id));
        expect(result.content[0].text).toContain('0 task(s)');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          blocks: unknown[];
          blocked_by: unknown[];
        };
        expect(data.blocks).toHaveLength(0);
        expect(data.blocked_by).toHaveLength(0);
      }
    });

    it('handles task that blocks others', async () => {
      // Create dependency: task1 blocks task2
      await client.callTool({
        name: 'add_dependency',
        arguments: {
          task_id: task1Id,
          blocks_task_id: task2Id,
        },
      });

      // Get dependencies for task1
      const result = (await client.callTool({
        name: 'get_dependencies',
        arguments: { task_id: task1Id },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          blocks: Array<{ blocks_task_id: number }>;
          blocked_by: unknown[];
        };
        expect(data.blocks).toHaveLength(1);
        expect(data.blocks[0].blocks_task_id).toBe(task2Id);
        expect(data.blocked_by).toHaveLength(0);
      }
    });
  });
});
