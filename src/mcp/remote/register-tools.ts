import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RestClient } from './rest-client.js';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ListTasksMcpSchema,
  CreateProjectSchema,
  toCompactTask,
} from '../../schemas/task.schema.js';

/**
 * Register all 26 MCP tools backed by REST API calls via RestClient.
 *
 * Tool names, descriptions, and input schemas match the local MCP server exactly.
 * Each handler proxies the request to the REST API and formats the MCP response.
 */
export function registerRemoteTools(server: McpServer, client: RestClient): void {

  // ── Task tools (8) ──────────────────────────────────────────────────────

  // Tool: create_task
  server.registerTool(
    'create_task',
    {
      description: 'Create a new task in a project',
      inputSchema: CreateTaskSchema,
    },
    async (args) => {
      try {
        const task = await client.createTask(args as unknown as import('../../cli/api/types.js').CreateTaskInput);
        return {
          content: [
            {
              type: 'text',
              text: `Task created: "${task.title}" (ID: ${task.id}, Status: ${task.status})`,
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to create task'
        );
      }
    }
  );

  // Tool: get_task
  server.registerTool(
    'get_task',
    {
      description: 'Get a task by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const task = await client.getTask(args.id);
        const summary = [
          `Task: ${task.title}`,
          `Status: ${task.status}`,
          `Priority: ${task.priority}`,
        ];
        if (task.description) {
          summary.push(`Description: ${task.description}`);
        }
        if (task.assignee) {
          summary.push(`Assignee: ${task.assignee}`);
        }
        if (task.due_date) {
          summary.push(`Due: ${task.due_date}`);
        }
        if (task.tags.length > 0) {
          summary.push(`Tags: ${task.tags.join(', ')}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get task'
        );
      }
    }
  );

  // Tool: update_task
  server.registerTool(
    'update_task',
    {
      description:
        'Update an existing task by ID. Can update title, description, status, priority, assignee, due_date, and tags.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: UpdateTaskSchema,
      }),
    },
    async (args) => {
      try {
        const task = await client.updateTask(args.id, args.updates);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.id} updated: "${task.title}" (Status: ${task.status}, Priority: ${task.priority})`,
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to update task'
        );
      }
    }
  );

  // Tool: list_tasks
  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks with optional filters (project_id, status, assignee, tags, due_before, due_after, updated_before, updated_after, search). Returns compact task summaries by default; pass verbose=true to include description and audit fields.',
      inputSchema: ListTasksMcpSchema,
    },
    async (args) => {
      try {
        const { verbose, ...filters } = args;
        const tasks = await client.listTasks(filters as unknown as import('../../cli/api/types.js').TaskFilters);
        if (tasks.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No tasks found matching filters.',
              },
            ],
            structuredContent: { tasks: [] } as unknown as { [x: string]: unknown },
          };
        }
        const summary = [`Found ${tasks.length} task(s):\n`];
        tasks.forEach((task) => {
          summary.push(
            `- [${task.id}] ${task.title} (${task.status}, ${task.priority})`
          );
        });
        const payloadTasks = verbose ? tasks : tasks.map(toCompactTask);
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: { tasks: payloadTasks } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to list tasks'
        );
      }
    }
  );

  // Tool: delete_task
  server.registerTool(
    'delete_task',
    {
      description: 'Delete a task by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        await client.deleteTask(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to delete task'
        );
      }
    }
  );

  // Tool: claim_task
  server.registerTool(
    'claim_task',
    {
      description:
        'Atomically claim an unassigned task, setting assignee and transitioning status to in_progress. Returns 409-equivalent error if already claimed.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        assignee: z.string().min(1).max(100),
      }),
    },
    async (args) => {
      try {
        const task = await client.claimTask(args.task_id, args.assignee);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.task_id} claimed by "${args.assignee}" (Status: ${task.status})`,
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to claim task'
        );
      }
    }
  );

  // Tool: list_subtasks
  server.registerTool(
    'list_subtasks',
    {
      description: 'List all subtasks (children) of a parent task',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const subtasks = await client.getSubtasks(args.task_id);
        if (subtasks.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} has no subtasks.`,
              },
            ],
            structuredContent: {
              parent_task_id: args.task_id,
              subtasks: [],
            } as unknown as { [x: string]: unknown },
          };
        }
        const summary = [`Task ${args.task_id} has ${subtasks.length} subtask(s):\n`];
        subtasks.forEach((task) => {
          summary.push(`- [${task.id}] ${task.title} (${task.status})`);
        });
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: {
            parent_task_id: args.task_id,
            subtasks,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to list subtasks'
        );
      }
    }
  );

  // Tool: get_subtasks
  server.registerTool(
    'get_subtasks',
    {
      description: 'Get all subtasks (children) of a parent task',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const subtasks = await client.getSubtasks(args.task_id);
        const summary = `Found ${subtasks.length} subtask(s) for task ${args.task_id}`;
        return {
          content: [
            {
              type: 'text',
              text: summary,
            },
          ],
          structuredContent: {
            parent_task_id: args.task_id,
            subtasks,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get subtasks'
        );
      }
    }
  );

  // ── Project tools (5) ────────────────────────────────────────────────────

  // Tool: create_project
  server.registerTool(
    'create_project',
    {
      description: 'Create a new project',
      inputSchema: CreateProjectSchema,
    },
    async (args) => {
      try {
        const project = await client.createProject(args);
        return {
          content: [
            {
              type: 'text',
              text: `Project created: ${project.name} (ID: ${project.id})`,
            },
          ],
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to create project'
        );
      }
    }
  );

  // Tool: get_project
  server.registerTool(
    'get_project',
    {
      description: 'Get a project by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const project = await client.getProject(args.id);
        const summary = [
          `Project: ${project.name}`,
          `Created: ${project.created_at}`,
        ];
        if (project.description) {
          summary.push(`Description: ${project.description}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get project'
        );
      }
    }
  );

  // Tool: list_projects
  server.registerTool(
    'list_projects',
    {
      description: 'List all projects',
      inputSchema: z.object({}),
    },
    async (_args) => {
      try {
        const projects = await client.listProjects();
        if (projects.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No projects found.',
              },
            ],
            structuredContent: { projects: [] } as unknown as { [x: string]: unknown },
          };
        }
        const summary = [`Found ${projects.length} project(s):\n`];
        projects.forEach((project) => {
          summary.push(`- [${project.id}] ${project.name}`);
        });
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: { projects } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to list projects'
        );
      }
    }
  );

  // Tool: update_project
  server.registerTool(
    'update_project',
    {
      description: 'Update an existing project by ID. Can update name and/or description.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: CreateProjectSchema.partial(),
      }),
    },
    async (args) => {
      try {
        const project = await client.updateProject(args.id, args.updates);
        return {
          content: [
            {
              type: 'text',
              text: `Project ${args.id} updated: ${project.name}`,
            },
          ],
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to update project'
        );
      }
    }
  );

  // Tool: delete_project
  server.registerTool(
    'delete_project',
    {
      description: 'Delete a project by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        await client.deleteProject(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Project ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to delete project'
        );
      }
    }
  );

  // ── Dependency tools (3) ─────────────────────────────────────────────────

  // Tool: add_dependency
  server.registerTool(
    'add_dependency',
    {
      description:
        'Add a dependency relationship between tasks (task_id blocks blocks_task_id)',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        blocks_task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const dependency = await client.addDependency(args.task_id, {
          blocks_task_id: args.blocks_task_id,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Dependency created: Task ${dependency.task_id} blocks Task ${dependency.blocks_task_id}`,
            },
          ],
          structuredContent: {
            dependency: {
              id: dependency.id,
              task_id: dependency.task_id,
              blocks_task_id: dependency.blocks_task_id,
              created_at: dependency.created_at,
            },
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to add dependency'
        );
      }
    }
  );

  // Tool: remove_dependency
  server.registerTool(
    'remove_dependency',
    {
      description: 'Remove a dependency relationship between tasks',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        blocks_task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        await client.removeDependency(args.task_id, args.blocks_task_id);
        return {
          content: [
            {
              type: 'text',
              text: `Dependency removed: Task ${args.task_id} no longer blocks Task ${args.blocks_task_id}`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to remove dependency'
        );
      }
    }
  );

  // Tool: get_dependencies
  server.registerTool(
    'get_dependencies',
    {
      description:
        'Get all dependencies for a task (tasks it blocks and tasks that block it)',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const deps = await client.getDependencies(args.task_id);
        const blocks = deps.blocks ?? [];
        const blockedBy = deps.blocked_by ?? [];
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.task_id} blocks ${blocks.length} task(s) and is blocked by ${blockedBy.length} task(s)`,
            },
          ],
          structuredContent: {
            task_id: args.task_id,
            blocks,
            blocked_by: blockedBy,
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get dependencies'
        );
      }
    }
  );

  // ── Comment tools (3) ───────────────────────────────────────────────────

  // Tool: add_comment
  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment to a task',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        author: z.string().min(1).max(100),
        content: z.string().min(1).max(5000),
      }),
    },
    async (args) => {
      try {
        const comment = await client.addComment(args.task_id, {
          author: args.author,
          content: args.content,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Comment added by ${comment.author} on task ${comment.task_id}`,
            },
          ],
          structuredContent: {
            comment: {
              id: comment.id,
              task_id: comment.task_id,
              author: comment.author,
              content: comment.content,
              created_at: comment.created_at,
            },
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to add comment'
        );
      }
    }
  );

  // Tool: get_comments
  server.registerTool(
    'get_comments',
    {
      description: 'Get all comments for a task in chronological order',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const comments = await client.getComments(args.task_id);
        return {
          content: [
            {
              type: 'text',
              text: `Found ${comments.length} comment(s) for task ${args.task_id}`,
            },
          ],
          structuredContent: {
            task_id: args.task_id,
            comments,
          } as unknown as Record<string, unknown>,
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get comments'
        );
      }
    }
  );

  // Tool: delete_comment
  server.registerTool(
    'delete_comment',
    {
      description: 'Delete a comment by ID',
      inputSchema: z.object({
        comment_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        // The local tool only takes comment_id, but the REST API route requires task_id in the URL.
        // The server handler ignores task_id and only uses commentId for deletion.
        // We use task_id=1 as a safe placeholder — any positive integer passes URL validation.
        await client.deleteComment(1, args.comment_id);
        return {
          content: [
            {
              type: 'text',
              text: `Comment ${args.comment_id} deleted successfully`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to delete comment'
        );
      }
    }
  );

  // ── Health tool (1) ─────────────────────────────────────────────────────

  // Tool: check_health
  server.registerTool(
    'check_health',
    {
      description: 'Check service health status, database connectivity, and version information',
      inputSchema: z.object({}),
    },
    async (_args) => {
      try {
        const health = await client.checkHealth();
        const status = health.status ?? 'unknown';
        const version = health.version ?? '1.0.0';
        const timestamp = health.timestamp ?? new Date().toISOString();
        const dbStatus = health.checks?.database ?? 'unknown';
        return {
          content: [
            {
              type: 'text',
              text: `Service Status: ${status}\nVersion: ${version}\nDatabase: ${dbStatus}\nTimestamp: ${timestamp}`,
            },
          ],
          structuredContent: health as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const timestamp = new Date().toISOString();
        const version = '1.0.0';
        return {
          content: [
            {
              type: 'text',
              text: `Service Status: unhealthy\nVersion: ${version}\nDatabase: failed\nTimestamp: ${timestamp}\nError: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          structuredContent: {
            status: 'unhealthy',
            timestamp,
            version,
            checks: { database: 'failed' },
          } as unknown as Record<string, unknown>,
        };
      }
    }
  );
}
