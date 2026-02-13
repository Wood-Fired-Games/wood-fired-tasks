import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskService } from '../../services/task.service.js';
import { ProjectService } from '../../services/project.service.js';
import { CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema } from '../../schemas/task.schema.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';

/**
 * Register all task-related MCP tools
 *
 * Registers 5 tools for task CRUD operations:
 * - create_task: Create a new task
 * - get_task: Get task by ID
 * - update_task: Update existing task
 * - list_tasks: List tasks with filters
 * - delete_task: Delete task by ID
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
      try {
        const task = taskService.createTask(args);
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
      try {
        const task = taskService.updateTask(args.id, args.updates);
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
        throw convertToMcpError(error);
      }
    }
  );

  // Tool: list_tasks
  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks with optional filters (project_id, status, assignee, tags, due_before, due_after, search)',
      inputSchema: TaskFiltersSchema,
    },
    async (args) => {
      try {
        const tasks = taskService.listTasks(args);

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

        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: { tasks } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
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
