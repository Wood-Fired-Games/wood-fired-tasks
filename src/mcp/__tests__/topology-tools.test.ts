/**
 * Wave 4.1 (task #318) — MCP `topology_check` tool test.
 *
 * Mirrors src/mcp/__tests__/dependency-tools.test.ts: spin up a real
 * createTestApp (in-memory SQLite), connect a paired InMemoryTransport,
 * then exercise the tool via the SDK client.
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

describe('MCP topology_check tool', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let flatProjectId: number;
  let dagProjectId: number;
  let dagTask1Id: number;
  let dagTask2Id: number;

  beforeEach(async () => {
    app = await createTestApp();

    // FLAT project: 2 unrelated tasks, no edges.
    const flat = app.projectService.createProject({ name: 'Flat' });
    flatProjectId = flat.id;
    app.taskService.createTask({
      title: 'f1',
      project_id: flatProjectId,
      created_by: 'test-agent',
    });
    app.taskService.createTask({
      title: 'f2',
      project_id: flatProjectId,
      created_by: 'test-agent',
    });

    // DAG project: 2 tasks with a single dependency edge.
    const dag = app.projectService.createProject({ name: 'DAG' });
    dagProjectId = dag.id;
    const t1 = app.taskService.createTask({
      title: 'd1',
      project_id: dagProjectId,
      created_by: 'test-agent',
    });
    dagTask1Id = t1.id;
    const t2 = app.taskService.createTask({
      title: 'd2',
      project_id: dagProjectId,
      created_by: 'test-agent',
    });
    dagTask2Id = t2.id;
    app.dependencyService.addDependency({
      task_id: dagTask1Id,
      blocks_task_id: dagTask2Id,
    });

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
      undefined,
      app.topologyService,
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client(
      { name: 'topology-test-client', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  it('registers the topology_check tool when topologyService is provided', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    expect(names).toContain('topology_check');
  });

  it('returns FLAT topology for a project with no dependencies', async () => {
    const result = (await client.callTool({
      name: 'topology_check',
      arguments: { project_id: flatProjectId },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    if (result.structuredContent) {
      const report = result.structuredContent as {
        topology: string;
        advisory: string;
        edges: unknown[];
        roots: number[];
        leaves: number[];
      };
      expect(report.topology).toBe('FLAT');
      expect(report.advisory).toBe('/tasks:loop');
      expect(report.edges).toEqual([]);
      expect(report.roots).toHaveLength(2);
      expect(report.leaves).toHaveLength(2);
    }
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('FLAT');
    }
  });

  it('returns DAG topology for a project with one dependency', async () => {
    const result = (await client.callTool({
      name: 'topology_check',
      arguments: { project_id: dagProjectId },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    if (result.structuredContent) {
      const report = result.structuredContent as {
        topology: string;
        advisory: string;
        edges: Array<{ from: number; to: number }>;
        roots: number[];
        leaves: number[];
      };
      expect(report.topology).toBe('DAG');
      expect(report.advisory).toBe('/gsd-autonomous');
      expect(report.edges).toEqual([
        { from: dagTask1Id, to: dagTask2Id },
      ]);
      expect(report.roots).toEqual([dagTask1Id]);
      expect(report.leaves).toEqual([dagTask2Id]);
    }
  });

  it('rejects missing project_id at the input schema layer', async () => {
    const result = (await client.callTool({
      name: 'topology_check',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it('rejects negative project_id at the input schema layer', async () => {
    const result = (await client.callTool({
      name: 'topology_check',
      arguments: { project_id: -5 },
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it('rejects zero project_id at the input schema layer', async () => {
    const result = (await client.callTool({
      name: 'topology_check',
      arguments: { project_id: 0 },
    })) as ToolResult;
    expect(result.isError).toBe(true);
  });
});
