import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from 'better-sqlite3';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { CommentService } from '../services/comment.service.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerDependencyTools } from './tools/dependency-tools.js';
import { registerCommentTools } from './tools/comment-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerHealthTools } from './tools/health-tools.js';
import {
  EVENTS_RESOURCE_URI,
  EVENTS_RESOURCE_NAME,
  EVENTS_RESOURCE_DESCRIPTION,
  getEventsResourceContent,
} from './resources/events.js';

/**
 * Create and configure an MCP server instance
 *
 * Factory function that creates an McpServer with 26 tools and 1 resource:
 * - 8 task tools (create, get, update, list, delete, claim, get_subtasks, list_subtasks)
 * - 5 project tools (create, get, update, list, delete)
 * - 7 dependency tools (add, remove, list, get_blocks, get_blocked_by, graph, check_cycle)
 * - 5 comment tools (add, list, get, update, delete)
 * - 1 health tool (check_health)
 * - 1 resource (events://stream - SSE event stream discovery)
 *
 * This pattern allows tests to instantiate servers without stdio transport.
 *
 * @param taskService - Service for task operations
 * @param projectService - Service for project operations
 * @param dependencyService - Service for dependency operations
 * @param commentService - Service for comment operations
 * @param db - Database instance for health checks
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createMcpServer(
  taskService: TaskService,
  projectService: ProjectService,
  dependencyService: DependencyService,
  commentService: CommentService,
  db: Database
): McpServer {
  const server = new McpServer({
    name: 'wood-fired-bugs',
    version: '1.0.0',
  });

  // Register all tools
  registerTaskTools(server, taskService, projectService);
  registerProjectTools(server, projectService);
  registerDependencyTools(server, dependencyService);
  registerCommentTools(server, commentService);
  registerHealthTools(server, db);

  // Register resources
  // Note: the API key is intentionally not passed to the resource — it would
  // be surfaced to the LLM as context (see task #196).
  const apiUrl = process.env.API_URL || 'http://localhost:3000/api/v1';

  server.resource(
    EVENTS_RESOURCE_NAME,
    EVENTS_RESOURCE_URI,
    {
      description: EVENTS_RESOURCE_DESCRIPTION,
      mimeType: 'text/event-stream',
    },
    async () => {
      return getEventsResourceContent(apiUrl);
    }
  );

  return server;
}
