import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

// Mirror of the shared MCP ToolResult shape used by sibling tests in this
// directory — kept local so this file doesn't leak the type across modules.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Wave 1.3 (task #311) — MCP surface coverage for `acceptance_criteria`.
 *
 * Verifies:
 *  - create_task accepts `acceptance_criteria` in its zod schema and persists
 *    the value (visible in the returned structuredContent + via get_task).
 *  - update_task can patch the value.
 *  - get_task surfaces the value on the returned task.
 *  - create_task rejects > 5000 chars with a clear error (zod validation).
 */
describe('MCP — acceptance_criteria (#311)', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    projectId = app.projectService.createProject({
      name: 'Wave 1.3 MCP',
    }).id;
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

  it('create_task accepts acceptance_criteria; get_task returns it', async () => {
    const md = '## Acceptance\n- column exists\n- round-trips';
    const created = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'MCP-acceptance-create',
        project_id: projectId,
        created_by: 'mcp-tester',
        acceptance_criteria: md,
      },
    })) as ToolResult;
    expect(created.isError).not.toBe(true);
    const task = created.structuredContent as { id: number; acceptance_criteria: string | null };
    expect(task.acceptance_criteria).toBe(md);

    const fetched = (await client.callTool({
      name: 'get_task',
      arguments: { id: task.id },
    })) as ToolResult;
    const fetchedTask = fetched.structuredContent as { acceptance_criteria: string | null };
    expect(fetchedTask.acceptance_criteria).toBe(md);
  });

  it('update_task can patch acceptance_criteria', async () => {
    const created = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'MCP-acceptance-update',
        project_id: projectId,
        created_by: 'mcp-tester',
      },
    })) as ToolResult;
    const id = (created.structuredContent as { id: number }).id;

    const updated = (await client.callTool({
      name: 'update_task',
      arguments: {
        id,
        updates: { acceptance_criteria: 'patched via MCP' },
      },
    })) as ToolResult;
    expect(updated.isError).not.toBe(true);
    expect(
      (updated.structuredContent as { acceptance_criteria: string | null })
        .acceptance_criteria,
    ).toBe('patched via MCP');

    // Clear via explicit null.
    const cleared = (await client.callTool({
      name: 'update_task',
      arguments: { id, updates: { acceptance_criteria: null } },
    })) as ToolResult;
    expect(
      (cleared.structuredContent as { acceptance_criteria: string | null })
        .acceptance_criteria,
    ).toBeNull();
  });

  it('create_task rejects acceptance_criteria > 5000 chars with a clear error', async () => {
    const tooLong = 'x'.repeat(5001);
    // MCP surface returns validation failures as a result with isError=true
    // (or an error message in `content`) rather than throwing — mirrors how
    // sibling MCP tools surface zod validation in this project. We accept
    // either shape so the test doesn't drift with future error-conversion
    // refinements; the load-bearing fact is "request did NOT succeed".
    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Over-long MCP',
        project_id: projectId,
        created_by: 'mcp-tester',
        acceptance_criteria: tooLong,
      },
    })) as ToolResult;
    const errored =
      result.isError === true ||
      (Array.isArray(result.content) &&
        result.content.some(
          (c) =>
            typeof c.text === 'string' &&
            /(5000|too_big|max)/i.test(c.text),
        ));
    expect(errored).toBe(true);

    // And the row was never created — defense in depth.
    const rows = app.db
      .prepare("SELECT id FROM tasks WHERE title = 'Over-long MCP'")
      .all() as Array<{ id: number }>;
    expect(rows).toHaveLength(0);
  });
});
