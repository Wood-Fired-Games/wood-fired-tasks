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
import { isMain } from '../../utils/is-main.js';
import { VERSION } from '../../utils/version.js';

/**
 * Remote MCP server entry point.
 *
 * Runs via stdio on the client machine and proxies all 21 MCP tools
 * to the backend's REST API over HTTP.
 *
 * Required environment variables:
 *   WFT_API_URL  - Base URL of the REST API (e.g., http://localhost:3000
 *                  or http://your-server.local:3000). Required — no default.
 *   WFT_API_KEY  - API key for authentication. Required.
 */

/**
 * Validate the env vars the remote MCP needs. Returns the resolved values on
 * success or an Error describing exactly which variable was missing/invalid.
 * Exported so unit tests can exercise the fail-fast paths without spawning
 * the full MCP server.
 */
export function resolveRemoteConfig(env: NodeJS.ProcessEnv = process.env): {
  apiUrl: string;
  apiKey: string;
} {
  const apiUrl = env.WFT_API_URL;
  const apiKey = env.WFT_API_KEY;

  if (!apiUrl || apiUrl.trim() === '') {
    throw new Error(
      'WFT_API_URL must be set when running the remote MCP server ' +
        '(e.g., http://localhost:3000 or http://your-server.local:3000). ' +
        'No default is provided to avoid silently connecting to the wrong host.',
    );
  }

  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'WFT_API_KEY must be set when running the remote MCP server. ' +
        'Example: WFT_API_KEY=your-api-key-here',
    );
  }

  return { apiUrl, apiKey };
}

async function main() {
  // Resolve config at startup. Fail fast with a readable message — never a
  // stack trace — when a required env var is missing.
  let apiUrl: string;
  let apiKey: string;
  try {
    ({ apiUrl, apiKey } = resolveRemoteConfig());
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // Create REST client
  const restClient = new RestClient(apiUrl, apiKey);

  // Create MCP server (same name/version as local server)
  const server = new McpServer({
    name: 'wood-fired-tasks',
    version: VERSION,
  });

  // Register all 27 tools backed by REST API
  registerRemoteTools(server, restClient);

  // Register the events resource (discovery/documentation)
  // Note: the API key is intentionally not passed to the resource — it would
  // be surfaced to the LLM as context (see task #196).
  const eventsApiUrl = `${apiUrl.replace(/\/$/, '')}/api/v1`;
  server.resource(
    EVENTS_RESOURCE_NAME,
    EVENTS_RESOURCE_URI,
    {
      description: EVENTS_RESOURCE_DESCRIPTION,
      mimeType: 'text/event-stream',
    },
    async () => {
      return getEventsResourceContent(eventsApiUrl);
    },
  );

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout reserved for JSON-RPC)
  console.error('Wood Fired Tasks MCP Server (remote) running on stdio');
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

// Only auto-start when executed directly (node dist/mcp/remote/index.js),
// not when imported by unit tests. isMain() resolves symlinks so this works
// under `npm link` / `npm install -g` — see wood-fired-tasks #334.
if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error('Fatal error during remote MCP startup:', error);
    process.exit(1);
  });
}
