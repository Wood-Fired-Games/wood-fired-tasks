import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// The MCP SDK callTool returns a union of CallToolResult | CompatibilityCallToolResult.
// The index signature makes content/structuredContent resolve to unknown.
// This type represents the standard (non-compatibility) result shape we expect.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.resolve(__dirname, '../../../skills/tasks');

// Known MCP tool names in the system. Keep in sync with the tools registered
// in src/mcp/tools/*.ts (server.ts wires them all up at startup).
const KNOWN_MCP_TOOLS = new Set([
  'create_task',
  'get_task',
  'update_task',
  'list_tasks',
  'delete_task',
  'claim_task',
  'list_subtasks',
  'get_subtasks',
  'create_project',
  'get_project',
  'update_project',
  'list_projects',
  'delete_project',
  'add_dependency',
  'remove_dependency',
  'get_dependencies',
  'add_comment',
  'get_comments',
  'delete_comment',
  'check_health',
]);

describe('E2E Regression: Full Task Lifecycle', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    // Create in-memory test app
    app = await createTestApp();

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

  it('complete project workflow through MCP', async () => {
    // 1. create_project
    const createProjectResult = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Regression Test Project' },
    })) as ToolResult;

    expect(createProjectResult.isError).toBeFalsy();
    const projectId = (
      createProjectResult.structuredContent as { id: number }
    ).id;
    expect(projectId).toBeDefined();

    // 2. create_task: "Implement feature" (high priority)
    const createTask1Result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Implement feature',
        project_id: projectId,
        priority: 'high',
        created_by: 'regression-test',
      },
    })) as ToolResult;

    expect(createTask1Result.isError).toBeFalsy();
    const task1Id = (createTask1Result.structuredContent as { id: number }).id;
    expect(task1Id).toBeDefined();

    // 3. create_task: "Write tests" (medium priority)
    const createTask2Result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Write tests',
        project_id: projectId,
        priority: 'medium',
        created_by: 'regression-test',
      },
    })) as ToolResult;

    expect(createTask2Result.isError).toBeFalsy();
    const task2Id = (createTask2Result.structuredContent as { id: number }).id;
    expect(task2Id).toBeDefined();

    // 4. add_dependency: task2 blocks task1 (tests must be written before feature ships)
    const addDepResult = (await client.callTool({
      name: 'add_dependency',
      arguments: {
        task_id: task2Id,
        blocks_task_id: task1Id,
      },
    })) as ToolResult;

    expect(addDepResult.isError).toBeFalsy();
    expect(addDepResult.content[0].text).toContain('Dependency created');

    // 5. add_comment on task1
    const addCommentResult = (await client.callTool({
      name: 'add_comment',
      arguments: {
        task_id: task1Id,
        author: 'tester',
        content: 'Starting work on this feature',
      },
    })) as ToolResult;

    expect(addCommentResult.isError).toBeFalsy();
    expect(addCommentResult.content[0].text).toContain('Comment added by');

    // 6. update_task task1 status to "in_progress"
    const updateTask1Result = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task1Id,
        updates: { status: 'in_progress' },
      },
    })) as ToolResult;

    expect(updateTask1Result.isError).toBeFalsy();

    // 7. get_task task1 - verify status is "in_progress", priority is "high"
    const getTask1Result = (await client.callTool({
      name: 'get_task',
      arguments: { id: task1Id },
    })) as ToolResult;

    expect(getTask1Result.isError).toBeFalsy();
    const task1Data = getTask1Result.structuredContent as {
      status: string;
      priority: string;
    };
    expect(task1Data.status).toBe('in_progress');
    expect(task1Data.priority).toBe('high');

    // 8. get_dependencies task1 - verify blocked_by contains task2
    const getDepsResult = (await client.callTool({
      name: 'get_dependencies',
      arguments: { task_id: task1Id },
    })) as ToolResult;

    expect(getDepsResult.isError).toBeFalsy();
    const depsData = getDepsResult.structuredContent as {
      blocked_by: Array<{ task_id: number }>;
    };
    expect(depsData.blocked_by).toHaveLength(1);
    expect(depsData.blocked_by[0].task_id).toBe(task2Id);

    // 9. get_comments task1 - verify 1 comment exists
    const getCommentsResult = (await client.callTool({
      name: 'get_comments',
      arguments: { task_id: task1Id },
    })) as ToolResult;

    expect(getCommentsResult.isError).toBeFalsy();
    const commentsData = getCommentsResult.structuredContent as {
      comments: unknown[];
    };
    expect(commentsData.comments).toHaveLength(1);

    // 10. update_task task2 status to "in_progress"
    const updateTask2InProgressResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task2Id,
        updates: { status: 'in_progress' },
      },
    })) as ToolResult;

    expect(updateTask2InProgressResult.isError).toBeFalsy();

    // 11. update_task task2 status to "done"
    const updateTask2DoneResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task2Id,
        updates: { status: 'done' },
      },
    })) as ToolResult;

    expect(updateTask2DoneResult.isError).toBeFalsy();

    // 12. remove_dependency task2 blocks task1
    const removeDepResult = (await client.callTool({
      name: 'remove_dependency',
      arguments: {
        task_id: task2Id,
        blocks_task_id: task1Id,
      },
    })) as ToolResult;

    expect(removeDepResult.isError).toBeFalsy();
    expect(removeDepResult.content[0].text).toContain('no longer blocks');

    // 13. update_task task1 status to "done"
    const updateTask1DoneResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task1Id,
        updates: { status: 'done' },
      },
    })) as ToolResult;

    expect(updateTask1DoneResult.isError).toBeFalsy();

    // 14. list_tasks with status "done" - verify both tasks appear
    const listDoneResult = (await client.callTool({
      name: 'list_tasks',
      arguments: { status: 'done' },
    })) as ToolResult;

    expect(listDoneResult.isError).toBeFalsy();
    // Pagination envelope: "Found 2 of 2 task(s)"
    expect(listDoneResult.content[0].text).toContain('Found 2 of 2 task(s)');

    // 15. delete_task task2
    const deleteTask2Result = (await client.callTool({
      name: 'delete_task',
      arguments: { id: task2Id },
    })) as ToolResult;

    expect(deleteTask2Result.isError).toBeFalsy();
    expect(deleteTask2Result.content[0].text).toContain('deleted');

    // Verify project still exists (cascading test)
    const getProjectResult = (await client.callTool({
      name: 'get_project',
      arguments: { id: projectId },
    })) as ToolResult;

    expect(getProjectResult.isError).toBeFalsy();
  });

  it('handles errors gracefully across tool boundaries', async () => {
    // Create project and task for testing
    const createProjectResult = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Error Test Project' },
    })) as ToolResult;

    const projectId = (
      createProjectResult.structuredContent as { id: number }
    ).id;

    const createTaskResult = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Test Task',
        project_id: projectId,
        created_by: 'tester',
      },
    })) as ToolResult;

    const taskId = (createTaskResult.structuredContent as { id: number }).id;

    // Try add_dependency with non-existent blocks_task_id
    const addDepResult = (await client.callTool({
      name: 'add_dependency',
      arguments: {
        task_id: taskId,
        blocks_task_id: 9999,
      },
    })) as ToolResult;

    expect(addDepResult.isError).toBe(true);
    expect(addDepResult.content[0].text).toBeTruthy();
    expect(addDepResult.content[0].text).toContain('MCP error');

    // Try add_comment on non-existent task
    const addCommentResult = (await client.callTool({
      name: 'add_comment',
      arguments: {
        task_id: 9999,
        author: 'tester',
        content: 'This should fail',
      },
    })) as ToolResult;

    expect(addCommentResult.isError).toBe(true);
    expect(addCommentResult.content[0].text).toBeTruthy();
    expect(addCommentResult.content[0].text).toContain('MCP error');

    // Try invalid status transition (open -> done without in_progress)
    const updateResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: taskId,
        updates: { status: 'done' },
      },
    })) as ToolResult;

    expect(updateResult.isError).toBe(true);
    expect(updateResult.content[0].text).toBeTruthy();
    expect(updateResult.content[0].text).toContain('MCP error');
  });
});

describe('Skill File Validation', () => {
  it('all skill files have valid frontmatter', () => {
    const skillFiles = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'));

    expect(skillFiles.length).toBeGreaterThan(0);

    for (const filename of skillFiles) {
      const filepath = path.join(SKILLS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Extract frontmatter between --- delimiters
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(
        frontmatterMatch,
        `${filename}: Should have valid frontmatter`
      ).toBeTruthy();

      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];

        // Check for required fields
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        expect(
          nameMatch,
          `${filename}: Should have 'name' field`
        ).toBeTruthy();
        if (nameMatch) {
          expect(
            nameMatch[1].trim(),
            `${filename}: 'name' should be non-empty`
          ).toBeTruthy();
        }

        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        expect(
          descMatch,
          `${filename}: Should have 'description' field`
        ).toBeTruthy();
        if (descMatch) {
          expect(
            descMatch[1].trim(),
            `${filename}: 'description' should be non-empty`
          ).toBeTruthy();
        }

        const disableMatch = frontmatter.match(
          /^disable-model-invocation:\s*(.+)$/m
        );
        expect(
          disableMatch,
          `${filename}: Should have 'disable-model-invocation' field`
        ).toBeTruthy();
        if (disableMatch) {
          const value = disableMatch[1].trim();
          expect(
            ['true', 'false'].includes(value),
            `${filename}: 'disable-model-invocation' should be a boolean (true/false)`
          ).toBe(true);
        }
      }
    }
  });

  it('all skill files reference valid MCP tool names', () => {
    const skillFiles = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'));

    for (const filename of skillFiles) {
      const filepath = path.join(SKILLS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Extract all wood-fired-bugs:TOOL_NAME references
      const toolReferences = content.matchAll(
        /wood-fired-bugs:([a-z_]+)/g
      );

      for (const match of toolReferences) {
        const toolName = match[1];
        expect(
          KNOWN_MCP_TOOLS.has(toolName),
          `${filename}: References unknown tool '${toolName}'. Known tools: ${Array.from(KNOWN_MCP_TOOLS).join(', ')}`
        ).toBe(true);
      }
    }
  });

  it('skill file count matches expected (11 files)', () => {
    // Update this count when adding or removing a skill file in
    // `skills/tasks/`. The README ("N Claude Code skill files") and
    // docs/MCP.md ("N pre-built skill files") references should be
    // updated in the same change.
    const skillFiles = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'));

    expect(skillFiles).toHaveLength(11);
  });

  it('each skill file has workflow steps', () => {
    const skillFiles = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'));

    for (const filename of skillFiles) {
      const filepath = path.join(SKILLS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Check for H2 section headers
      const hasH2Heading = /^## /m.test(content);
      expect(
        hasH2Heading,
        `${filename}: Should have at least one H2 heading (##)`
      ).toBe(true);

      // Check for numbered steps (list items) OR numbered section headings (### 1. etc)
      const hasNumberedSteps = /^\d+\.\s/m.test(content);
      const hasNumberedHeadings = /^###\s+\d+\.\s/m.test(content);
      expect(
        hasNumberedSteps || hasNumberedHeadings,
        `${filename}: Should contain numbered steps (e.g., "1. ") or numbered headings (e.g., "### 1. ")`
      ).toBe(true);
    }
  });
});
