import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toStructuredContent } from '../lib/structured-content.js';
import type { DependencyService } from '../../services/dependency.service.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';

export function registerDependencyTools(
  server: McpServer,
  dependencyService: DependencyService
): void {
  // add_dependency - Create a dependency relationship
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
        const dependency = dependencyService.addDependency({
          task_id: args.task_id,
          blocks_task_id: args.blocks_task_id,
        });

        return {
          content: [
            {
              type: 'text',
              text: `Dependency created: Task ${dependency.task_id} blocks Task ${dependency.blocks_task_id}`,
            },
          ],
          structuredContent: toStructuredContent({
            dependency: {
              id: dependency.id,
              task_id: dependency.task_id,
              blocks_task_id: dependency.blocks_task_id,
              created_at: dependency.created_at,
            },
          }),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // remove_dependency - Remove a dependency relationship
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
        dependencyService.removeDependency(args.task_id, args.blocks_task_id);

        return {
          content: [
            {
              type: 'text',
              text: `Dependency removed: Task ${args.task_id} no longer blocks Task ${args.blocks_task_id}`,
            },
          ],
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // get_dependencies - Get all dependencies for a task
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
        const taskId = args.task_id;
        const blocks = dependencyService.getBlockedBy(taskId);
        const blockedBy = dependencyService.getBlockers(taskId);

        return {
          content: [
            {
              type: 'text',
              text: `Task ${taskId} blocks ${blocks.length} task(s) and is blocked by ${blockedBy.length} task(s)`,
            },
          ],
          structuredContent: toStructuredContent({
            task_id: taskId,
            blocks: blocks,
            blocked_by: blockedBy,
          }),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );
}
