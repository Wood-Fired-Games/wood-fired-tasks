import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

// The MCP SDK callTool returns a union whose index signature resolves
// content/structuredContent to unknown. This is the standard shape we expect.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP wait_for_unblock Tool (task #455)', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    const project = app.projectService.createProject({ name: 'Unblock Test' });
    testProjectId = project.id;

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client(
      { name: 'wait-for-unblock-test', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  it('fast path: returns already_unblocked when task is not blocked', async () => {
    const task = app.taskService.createTask({
      title: 'Open task',
      project_id: testProjectId,
      created_by: 'test-agent',
    });

    const result = (await client.callTool({
      name: 'wait_for_unblock',
      arguments: { task_id: task.id, timeout_seconds: 60 },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      status: string;
      task: { id: number; status: string };
      applied_timeout_seconds: number;
    };
    expect(sc.status).toBe('already_unblocked');
    expect(sc.task.id).toBe(task.id);
    expect(sc.task.status).toBe('open');
    expect(sc.applied_timeout_seconds).toBe(60);
  });

  it('happy path: resolves unblocked when a blocked task transitions to open mid-wait', async () => {
    const task = app.taskService.createTask({
      title: 'Blocked task',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    // Move to blocked so the tool actually waits.
    app.taskService.updateTask(task.id, { status: 'blocked' });

    // Start the wait (does not await yet) — generous timeout so the deadline
    // never fires during this test.
    const waitCall = client.callTool({
      name: 'wait_for_unblock',
      arguments: { task_id: task.id, timeout_seconds: 30 },
    }) as Promise<ToolResult>;

    // Drive the blocked -> open transition from within the test, on a later
    // tick so the subscription is definitely live. This emits
    // task.status_changed { from: 'blocked', to: 'open' } on the in-process bus.
    await new Promise((r) => setTimeout(r, 25));
    app.taskService.updateTask(task.id, { status: 'open' });

    const result = await waitCall;
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      status: string;
      task: { id: number; status: string };
      applied_timeout_seconds: number;
    };
    expect(sc.status).toBe('unblocked');
    expect(sc.task.id).toBe(task.id);
    expect(sc.task.status).toBe('open');
    expect(sc.applied_timeout_seconds).toBe(30);
  });

  it('timeout path: returns timeout envelope (no error) when deadline elapses', async () => {
    const task = app.taskService.createTask({
      title: 'Stays blocked',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    app.taskService.updateTask(task.id, { status: 'blocked' });

    // timeout_seconds clamps to a minimum of 1 → ~1s real deadline. We never
    // unblock the task, so the deadline must fire.
    const result = (await client.callTool({
      name: 'wait_for_unblock',
      arguments: { task_id: task.id, timeout_seconds: 1 },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      status: string;
      task_id: number;
      waited_seconds: number;
      applied_timeout_seconds: number;
    };
    expect(sc.status).toBe('timeout');
    expect(sc.task_id).toBe(task.id);
    expect(sc.waited_seconds).toBe(1);
    expect(sc.applied_timeout_seconds).toBe(1);
  }, 10_000);

  it('clamps timeout_seconds above the 1800 max and surfaces the applied value', async () => {
    const task = app.taskService.createTask({
      title: 'Clamp check',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    // Not blocked → returns immediately, but still echoes the clamped timeout.
    const result = (await client.callTool({
      name: 'wait_for_unblock',
      arguments: { task_id: task.id, timeout_seconds: 99999 },
    })) as ToolResult;

    const sc = result.structuredContent as {
      status: string;
      applied_timeout_seconds: number;
    };
    expect(sc.status).toBe('already_unblocked');
    expect(sc.applied_timeout_seconds).toBe(1800);
  });

  it('unauthorized / unknown task: returns the same MCP error get_task produces', async () => {
    const result = (await client.callTool({
      name: 'wait_for_unblock',
      arguments: { task_id: 999999, timeout_seconds: 5 },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('MCP error');
      expect(result.content[0].text).toContain('999999');
    }
  });
});
