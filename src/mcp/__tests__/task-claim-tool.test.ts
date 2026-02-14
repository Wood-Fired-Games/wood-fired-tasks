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

describe('MCP claim_task Tool', () => {
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
    app.db.close();
  });

  it('claims an unassigned open task successfully', async () => {
    // Create an unassigned task
    const task = app.taskService.createTask({
      title: 'Claimable task',
      project_id: testProjectId,
      created_by: 'test-agent',
    });

    const result = (await client.callTool({
      name: 'claim_task',
      arguments: {
        task_id: task.id,
        assignee: 'agent-1',
      },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain(`Task ${task.id} claimed by "agent-1"`);
      expect(result.content[0].text).toContain('Status: in_progress');
    }
  });

  it('returns claimed task details in structuredContent', async () => {
    const task = app.taskService.createTask({
      title: 'Structured claim',
      project_id: testProjectId,
      created_by: 'test-agent',
    });

    const result = (await client.callTool({
      name: 'claim_task',
      arguments: {
        task_id: task.id,
        assignee: 'agent-2',
      },
    })) as ToolResult;

    expect(result.structuredContent).toBeDefined();
    if (result.structuredContent) {
      const claimed = result.structuredContent as {
        id: number;
        status: string;
        assignee: string;
      };
      expect(claimed.id).toBe(task.id);
      expect(claimed.status).toBe('in_progress');
      expect(claimed.assignee).toBe('agent-2');
    }
  });

  it('returns MCP error when task is already claimed', async () => {
    // Create and claim a task
    const task = app.taskService.createTask({
      title: 'Already claimed task',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    app.taskService.claimTask(task.id, 'agent-1');

    // Try to claim again
    const result = (await client.callTool({
      name: 'claim_task',
      arguments: {
        task_id: task.id,
        assignee: 'agent-2',
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('MCP error');
      // After first claim, status is in_progress - service rejects non-open tasks
      expect(result.content[0].text).toMatch(/already claimed|cannot be claimed/);
    }
  });

  it('returns MCP error for non-existent task', async () => {
    const result = (await client.callTool({
      name: 'claim_task',
      arguments: {
        task_id: 9999,
        assignee: 'agent-1',
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('MCP error');
      expect(result.content[0].text).toContain('9999');
    }
  });

  it('returns validation error for empty assignee', async () => {
    const result = (await client.callTool({
      name: 'claim_task',
      arguments: {
        task_id: 1,
        assignee: '',
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('MCP error');
      expect(result.content[0].text).toContain('validation');
    }
  });

  it('returns MCP error when claiming a non-open task', async () => {
    // Create a task and move it to in_progress (already in a non-claimable state)
    const task = app.taskService.createTask({
      title: 'In-progress task',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    app.taskService.updateTask(task.id, { status: 'in_progress' });

    const result = (await client.callTool({
      name: 'claim_task',
      arguments: {
        task_id: task.id,
        assignee: 'agent-1',
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('MCP error');
    }
  });
});
