import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RestClient } from './rest-client.js';
import { registerRemoteTools } from './register-tools.js';
import {
  EVENTS_RESOURCE_URI,
  EVENTS_RESOURCE_NAME,
  EVENTS_RESOURCE_DESCRIPTION,
  getEventsResourceContent,
} from '../resources/events.js';

/**
 * Remote MCP server entry point.
 *
 * Runs via stdio on the client machine and proxies all 26 MCP tools
 * to the Linux backend's REST API over HTTP.
 *
 * Required environment variables:
 *   WFB_API_URL  - Base URL of the REST API (e.g., http://192.168.69.69:3000)
 *   WFB_API_KEY  - API key for authentication
 */

// Validate required environment variables
const apiUrl = process.env.WFB_API_URL || 'http://192.168.69.69:3000';
const apiKey = process.env.WFB_API_KEY;

if (!apiKey) {
  console.error('Error: WFB_API_KEY environment variable is required.');
  console.error('Example: WFB_API_KEY=your-api-key-here');
  process.exit(1);
}

async function main() {
  // Create REST client
  const restClient = new RestClient(apiUrl as string, apiKey as string);

  // Create MCP server (same name/version as local server)
  const server = new McpServer({
    name: 'wood-fired-bugs',
    version: '1.0.0',
  });

  // Register all 26 tools backed by REST API
  registerRemoteTools(server, restClient);

  // Register the events resource (discovery/documentation)
  const eventsApiUrl = `${(apiUrl as string).replace(/\/$/, '')}/api/v1`;
  server.resource(
    EVENTS_RESOURCE_NAME,
    EVENTS_RESOURCE_URI,
    {
      description: EVENTS_RESOURCE_DESCRIPTION,
      mimeType: 'text/event-stream',
    },
    async () => {
      return getEventsResourceContent(eventsApiUrl, apiKey as string);
    }
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout reserved for JSON-RPC)
  console.error('Wood Fired Bugs MCP Server (remote) running on stdio');
  console.error(`Connected to backend: ${apiUrl}`);
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

main().catch((error) => {
  console.error('Fatal error during remote MCP startup:', error);
  process.exit(1);
});
