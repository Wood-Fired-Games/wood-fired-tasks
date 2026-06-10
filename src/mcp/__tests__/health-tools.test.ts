import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import { VERSION } from '../../utils/version.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

describe('MCP Health Tools', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    app = await createTestApp();

    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  describe('check_health tool', () => {
    it('returns healthy status when database is ok', async () => {
      const result = (await client.callTool({
        name: 'check_health',
        arguments: {},
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('healthy');
        expect(result.content[0].text).toContain('ok');
        expect(result.content[0].text).toContain(VERSION);
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const health = result.structuredContent as {
          status: string;
          version: string;
          database: {
            path: string;
            projects: number;
            maxTaskId: number | null;
            latestActivity: string | null;
          };
          checks: { database: string };
        };
        expect(health.status).toBe('healthy');
        expect(health.version).toBe(VERSION);
        expect(health.checks.database).toBe('ok');
        // DB fingerprint (task #354).
        expect(typeof health.database.path).toBe('string');
        expect(typeof health.database.projects).toBe('number');
        expect(health.database).toHaveProperty('maxTaskId');
        expect(health.database).toHaveProperty('latestActivity');
      }
    });

    // Task #1004: lint finding for the edge-less blocked dead end.
    describe('blocked-without-edge finding', () => {
      interface Finding {
        check: string;
        severity: string;
        message: string;
        suggestion: string;
        taskIds: number[];
      }

      function setup(): { blockedId: number; blockerId: number } {
        const projectId = app.projectService.createProject({ name: 'Health lint' }).id;
        const blockedId = app.taskService.createTask({
          title: 'stranded',
          project_id: projectId,
          created_by: 'tester',
        }).id;
        const blockerId = app.taskService.createTask({
          title: 'blocker',
          project_id: projectId,
          created_by: 'tester',
        }).id;
        return { blockedId, blockerId };
      }

      async function callHealthFindings(): Promise<Finding[]> {
        const result = (await client.callTool({
          name: 'check_health',
          arguments: {},
        })) as ToolResult;
        return (result.structuredContent as { findings: Finding[] }).findings;
      }

      it('flags a blocked task with zero blocking edges (severity warning)', async () => {
        const { blockedId } = setup();
        // Reproduce the merge-queue-bounce dead end: status flipped to blocked
        // with NO edge (plain status update, no blocked_by).
        app.taskService.updateTask(blockedId, { status: 'blocked' });

        const findings = await callHealthFindings();
        const finding = findings.find((f) => f.check === 'blocked-without-edge');
        expect(finding).toBeDefined();
        expect(finding!.severity).toBe('warning');
        expect(finding!.taskIds).toContain(blockedId);
        expect(finding!.message).toContain('blocked');
        expect(finding!.suggestion).toContain('blocked_by');
      });

      it('stays quiet when every blocked task has a blocking edge', async () => {
        const { blockedId, blockerId } = setup();
        // The atomic affordance: edge + status in one call.
        app.taskService.updateTask(blockedId, {
          status: 'blocked',
          blocked_by: [blockerId],
        });

        const findings = await callHealthFindings();
        expect(findings.filter((f) => f.check === 'blocked-without-edge')).toEqual([]);
      });

      it('stays quiet on a backlog with no blocked tasks at all', async () => {
        setup();
        const findings = await callHealthFindings();
        expect(findings).toEqual([]);
      });
    });
  });
});
