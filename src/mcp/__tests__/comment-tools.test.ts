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

describe('MCP Comment Tools', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let testProjectId: number;
  let testTaskId: number;

  beforeEach(async () => {
    // Create in-memory test app
    app = await createTestApp();

    // Create a test project for tools to use
    const project = app.projectService.createProject({ name: 'Test Project' });
    testProjectId = project.id;

    // Create test task for comment tests
    const task = app.taskService.createTask({
      title: 'Test Task',
      project_id: testProjectId,
      created_by: 'test-agent',
    });
    testTaskId = task.id;

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

  describe('add_comment tool', () => {
    it('adds comment to existing task', async () => {
      const result = (await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: 'test-author',
          content: 'This is a test comment',
        },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Comment added by');
        expect(result.content[0].text).toContain('test-author');
        expect(result.content[0].text).toContain(String(testTaskId));
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          comment: {
            id: number;
            task_id: number;
            author: string;
            content: string;
            created_at: string;
            updated_at: string;
          };
        };
        expect(data.comment.id).toBeDefined();
        expect(data.comment.task_id).toBe(testTaskId);
        expect(data.comment.author).toBe('test-author');
        expect(data.comment.content).toBe('This is a test comment');
        expect(data.comment.created_at).toBeDefined();
        expect(data.comment.updated_at).toBeDefined();
      }
    });

    it('returns error for non-existent task_id', async () => {
      const result = (await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: 9999,
          author: 'test-author',
          content: 'This should fail',
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });

    it('validates required fields: empty author returns error', async () => {
      const result = (await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: '',
          content: 'Valid content',
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });

    it('validates required fields: empty content returns error', async () => {
      const result = (await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: 'test-author',
          content: '',
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });

  describe('get_comments tool', () => {
    it('returns comments in chronological order', async () => {
      // Add 3 comments
      await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: 'author1',
          content: 'First comment',
        },
      });

      await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: 'author2',
          content: 'Second comment',
        },
      });

      await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: 'author3',
          content: 'Third comment',
        },
      });

      const result = (await client.callTool({
        name: 'get_comments',
        arguments: { task_id: testTaskId },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Found 3 comment(s)');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          task_id: number;
          comments: Array<{ author: string; content: string }>;
        };
        expect(data.task_id).toBe(testTaskId);
        expect(data.comments).toHaveLength(3);
        expect(data.comments[0].author).toBe('author1');
        expect(data.comments[1].author).toBe('author2');
        expect(data.comments[2].author).toBe('author3');
      }
    });

    it('returns empty array for task with no comments', async () => {
      const result = (await client.callTool({
        name: 'get_comments',
        arguments: { task_id: testTaskId },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Found 0 comment(s)');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          comments: unknown[];
        };
        expect(data.comments).toHaveLength(0);
      }
    });

    it('returns error for non-existent task', async () => {
      const result = (await client.callTool({
        name: 'get_comments',
        arguments: { task_id: 9999 },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });

  describe('delete_comment tool', () => {
    it('deletes existing comment', async () => {
      // Add a comment first
      const addResult = (await client.callTool({
        name: 'add_comment',
        arguments: {
          task_id: testTaskId,
          author: 'test-author',
          content: 'Comment to delete',
        },
      })) as ToolResult;

      const commentId = (
        addResult.structuredContent as {
          comment: { id: number };
        }
      ).comment.id;

      // Delete it
      const result = (await client.callTool({
        name: 'delete_comment',
        arguments: { comment_id: commentId },
      })) as ToolResult;

      expect(result.isError).toBeFalsy();
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('deleted successfully');
        expect(result.content[0].text).toContain(String(commentId));
      }

      // Verify it's gone by getting all comments
      const getResult = (await client.callTool({
        name: 'get_comments',
        arguments: { task_id: testTaskId },
      })) as ToolResult;

      if (getResult.structuredContent) {
        const data = getResult.structuredContent as {
          comments: unknown[];
        };
        expect(data.comments).toHaveLength(0);
      }
    });

    it('returns error for non-existent comment_id', async () => {
      const result = (await client.callTool({
        name: 'delete_comment',
        arguments: { comment_id: 9999 },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });
});
