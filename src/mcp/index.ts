import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from '../index.js';
import { createMcpServer } from './server.js';

/**
 * MCP server stdio entry point
 *
 * Initializes the database, services, and MCP server, then connects
 * to stdio transport for communication with MCP clients.
 */
async function main() {
  // Determine database path from environment or use default
  const dbPath = process.env.DB_PATH || './data/tasks.db';

  // Initialize application (database, repositories, services)
  const app = await createApp(dbPath);

  // Create MCP server with initialized services
  const server = createMcpServer(
    app.taskService,
    app.projectService,
    app.dependencyService,
    app.commentService,
    app.db
  );

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Log to stderr (stdout reserved for JSON-RPC)
  console.error('Wood Fired Bugs MCP Server running on stdio');
}

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
