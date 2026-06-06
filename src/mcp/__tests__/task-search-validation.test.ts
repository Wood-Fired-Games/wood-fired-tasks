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

describe('MCP list_tasks search validation', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;

  beforeEach(async () => {
    app = await createTestApp();

    const project = app.projectService.createProject({
      name: 'Search Test Project',
    });
    testProjectId = project.id;

    // Seed two tasks so the FTS index has rows.
    app.taskService.createTask({
      title: 'Fix login bug',
      description: 'auth and session',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    app.taskService.createTask({
      title: 'Database migration bug',
      description: 'migrate users to new schema',
      project_id: testProjectId,
      created_by: 'test-agent',
    });

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

  const MALFORMED_INPUTS: Array<{ name: string; input: string }> = [
    { name: 'bare double quote', input: '"' },
    { name: 'unterminated NEAR(', input: 'NEAR(' },
    { name: 'bare wildcard', input: '*' },
    { name: 'dangling OR operator', input: 'foo OR' },
    { name: 'unterminated phrase', input: '"unterminated phrase' },
  ];

  for (const { name, input } of MALFORMED_INPUTS) {
    it(`list_tasks returns structured MCP validation error for ${name}`, async () => {
      const result = (await client.callTool({
        name: 'list_tasks',
        arguments: { search: input },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      const errText = result.content[0].type === 'text' ? (result.content[0].text ?? '') : '';

      // Surfaced as the MCP validation envelope, not an InternalError.
      expect(errText).toContain('MCP error');
      expect(errText.toLowerCase()).toContain('validation');

      // No raw SQLite parser text leaked to the client.
      expect(errText).not.toContain('fts5:');
      expect(errText).not.toContain('SQLITE');
      expect(errText).not.toContain('unterminated string');
      expect(errText).not.toContain('parse error');

      // No InternalError text — InternalError is what the un-fixed code path
      // would have produced.
      expect(errText.toLowerCase()).not.toContain('internal error');
      expect(errText.toLowerCase()).not.toContain('an internal error occurred');
    });
  }

  it('list_tasks rejects search with more than 32 terms via the schema cap', async () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `t${i}`).join(' ');
    const result = (await client.callTool({
      name: 'list_tasks',
      arguments: { search: tooMany },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const errText = result.content[0].type === 'text' ? (result.content[0].text ?? '') : '';
    expect(errText.toLowerCase()).toContain('validation');
    expect(errText).not.toContain('fts5:');
    expect(errText).not.toContain('SQLITE');
  });

  it('list_tasks succeeds for a valid simple search', async () => {
    const result = (await client.callTool({
      name: 'list_tasks',
      arguments: { search: 'login' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const text = result.content[0].type === 'text' ? (result.content[0].text ?? '') : '';
    expect(text).toContain('Fix login bug');
  });

  it('list_tasks succeeds for a valid prefix search', async () => {
    const result = (await client.callTool({
      name: 'list_tasks',
      arguments: { search: 'migr*' },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    const text = result.content[0].type === 'text' ? (result.content[0].text ?? '') : '';
    expect(text).toContain('migration');
  });
});
