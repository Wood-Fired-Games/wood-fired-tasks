import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskService } from '../../services/task.service.js';
import { ProjectService } from '../../services/project.service.js';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ListTasksMcpSchema,
  CompletionReportSchema,
  toCompactTask,
} from '../../schemas/task.schema.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { convertToMcpError } from '../errors.js';

/**
 * Register all task-related MCP tools
 *
 * Registers 6 tools for task CRUD operations plus claim:
 * - create_task: Create a new task
 * - get_task: Get task by ID
 * - update_task: Update existing task
 * - list_tasks: List tasks with filters
 * - delete_task: Delete task by ID
 * - claim_task: Atomically claim an unassigned task
 */
export function registerTaskTools(
  server: McpServer,
  taskService: TaskService,
  projectService: ProjectService
): void {
  // Tool: create_task
  server.registerTool(
    'create_task',
    {
      description: 'Create a new task in a project',
      inputSchema: CreateTaskSchema,
    },
    async (args) => {
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'create_task', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const task = taskService.createTask(args);
        console.error(JSON.stringify({ level: 'info', traceId, tool: 'create_task', event: 'success' }));
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
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'create_task', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
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
        const task = taskService.getTask(args.id);
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
        throw convertToMcpError(error);
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
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'update_task', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const task = taskService.updateTask(args.id, args.updates);
        console.error(JSON.stringify({ level: 'info', traceId, tool: 'update_task', event: 'success' }));
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
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'update_task', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
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
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'list_tasks', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const { verbose, ...filters } = args;
        const tasks = taskService.listTasks(filters);

        if (tasks.length === 0) {
          console.error(JSON.stringify({ level: 'info', traceId, tool: 'list_tasks', event: 'success' }));
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

        console.error(JSON.stringify({ level: 'info', traceId, tool: 'list_tasks', event: 'success' }));
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
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'list_tasks', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
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
        taskService.deleteTask(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw convertToMcpError(error);
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
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'claim_task', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const task = taskService.claimTask(args.task_id, args.assignee);
        console.error(JSON.stringify({ level: 'info', traceId, tool: 'claim_task', event: 'success' }));
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
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'claim_task', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
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
        const subtasks = taskService.getSubtasks(args.task_id);

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
        throw convertToMcpError(error);
      }
    }
  );

  // Tool: completion_report
  server.registerTool(
    'completion_report',
    {
      description:
        'Dashboard view of tasks completed (status=done) within a time interval. ' +
        'Provide either `days` (trailing window) or `start`+`end` ISO8601 bounds. ' +
        'Returns per-task rows plus aggregates by project, assignee, priority, and daily throughput.',
      inputSchema: CompletionReportSchema,
    },
    async (args) => {
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'completion_report', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const report = taskService.getCompletionReport(args);

        const summary = [
          `${report.total} task(s) completed between ${report.range.start} and ${report.range.end}`,
        ];
        if (report.total > 0) {
          summary.push('');
          summary.push('Top by project:');
          for (const r of report.by_project.slice(0, 5)) {
            summary.push(`  project ${r.project_id}: ${r.count}`);
          }
          summary.push('Top by assignee:');
          for (const r of report.by_assignee.slice(0, 5)) {
            summary.push(`  ${r.assignee}: ${r.count}`);
          }
        }

        console.error(JSON.stringify({ level: 'info', traceId, tool: 'completion_report', event: 'success' }));
        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: report as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'completion_report', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
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
        const subtasks = taskService.getSubtasks(args.task_id);
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
        throw convertToMcpError(error);
      }
    }
  );
}
