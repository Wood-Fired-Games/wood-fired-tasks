import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { CommentService } from '../services/comment.service.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerDependencyTools } from './tools/dependency-tools.js';
import { registerCommentTools } from './tools/comment-tools.js';

/**
 * Create and configure an MCP server instance
 *
 * Factory function that creates an McpServer with task tools registered.
 * This pattern allows tests to instantiate servers without stdio transport.
 *
 * @param taskService - Service for task operations
 * @param projectService - Service for project operations
 * @param dependencyService - Service for dependency operations
 * @param commentService - Service for comment operations
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createMcpServer(
  taskService: TaskService,
  projectService: ProjectService,
  dependencyService: DependencyService,
  commentService: CommentService
): McpServer {
  const server = new McpServer({
    name: 'wood-fired-bugs',
    version: '1.0.0',
  });

  // Register all tools
  registerTaskTools(server, taskService, projectService);
  registerDependencyTools(server, dependencyService);
  registerCommentTools(server, commentService);

  return server;
}
