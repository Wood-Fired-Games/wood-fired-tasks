import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

// Local mirror of the shared MCP ToolResult shape (kept local so this file
// doesn't leak the type across modules — same convention as the sibling
// acceptance-criteria test).
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Wave 1.4 (task #312) — MCP surface coverage for verification_evidence.
 *
 * Verifies:
 *  - update_task accepts verification_evidence on its UpdateTaskClientSchema.
 *  - get_task surfaces the parsed object on the structuredContent payload.
 *  - Round-trip: write via MCP, read via the same service the REST routes
 *    use — values match deep-equal (cross-surface coherence).
 *  - Unknown verdicts are rejected (Zod validation surfaces as an MCP error).
 */
describe('MCP — verification_evidence (#312)', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let projectId: number;

  beforeEach(async () => {
    app = await createTestApp();
    projectId = app.projectService.createProject({
      name: 'wave-1-4-mcp',
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

  async function newTaskId(): Promise<number> {
    const created = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'mcp-verify',
        project_id: projectId,
        created_by: 'mcp-tester',
      },
    })) as ToolResult;
    return (created.structuredContent as { id: number }).id;
  }

  it('update_task accepts verification_evidence; get_task returns it deep-equal', async () => {
    const id = await newTaskId();
    const evidence = {
      verdict: 'PASS' as const,
      checks: [
        { name: 'build', status: 'PASS' as const, evidence_url_or_text: 'green' },
        { name: 'tests', status: 'SKIP' as const, evidence_url_or_text: 'n/a' },
      ],
      verifier_session_id: 'mcp-sess-1',
      verifier_request_id: 'mcp-req-1',
      verified_at: '2026-05-23T15:00:00.000Z',
    };

    const updated = (await client.callTool({
      name: 'update_task',
      arguments: { id, updates: { verification_evidence: evidence } },
    })) as ToolResult;
    expect(updated.isError).not.toBe(true);
    expect(
      (updated.structuredContent as { verification_evidence: unknown })
        .verification_evidence
    ).toEqual(evidence);

    const fetched = (await client.callTool({
      name: 'get_task',
      arguments: { id },
    })) as ToolResult;
    expect(
      (fetched.structuredContent as { verification_evidence: unknown })
        .verification_evidence
    ).toEqual(evidence);
  });

  it('write via MCP, read via service (REST equivalent) — deep equal', async () => {
    const id = await newTaskId();
    const evidence = { verdict: 'PARTIAL' as const, verifier_session_id: 'xfer' };
    await client.callTool({
      name: 'update_task',
      arguments: { id, updates: { verification_evidence: evidence } },
    });
    // The REST route eventually calls taskService.getTask — exercise the same
    // code path here to confirm cross-surface coherence without standing up
    // a Fastify instance for this single check.
    const fromService = app.taskService.getTask(id);
    expect(fromService.verification_evidence).toEqual(evidence);
  });

  it('update_task rejects an unknown verdict', async () => {
    const id = await newTaskId();
    const result = (await client.callTool({
      name: 'update_task',
      arguments: {
        id,
        updates: { verification_evidence: { verdict: 'BOGUS' } },
      },
    })) as ToolResult;
    const errored =
      result.isError === true ||
      (Array.isArray(result.content) &&
        result.content.some(
          (c) =>
            typeof c.text === 'string' &&
            /(invalid|verdict|enum|BOGUS)/i.test(c.text),
        ));
    expect(errored).toBe(true);

    // Defense in depth: the row's verification_evidence remained NULL.
    const row = app.db
      .prepare('SELECT verification_evidence FROM tasks WHERE id = ?')
      .get(id) as { verification_evidence: string | null };
    expect(row.verification_evidence).toBeNull();
  });
});
