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
      app.db
    );

    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

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
        expect(result.content[0].text).toContain('1.12.0');
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
        expect(health.version).toBe('1.12.0');
        expect(health.checks.database).toBe('ok');
        // DB fingerprint (task #354).
        expect(typeof health.database.path).toBe('string');
        expect(typeof health.database.projects).toBe('number');
        expect(health.database).toHaveProperty('maxTaskId');
        expect(health.database).toHaveProperty('latestActivity');
      }
    });
  });
});
