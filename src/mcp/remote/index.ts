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
import { readCredentials, getCredentialsPath } from '../../cli/auth/credentials.js';

/**
 * Remote MCP server entry point.
 *
 * Runs via stdio on the client machine and proxies all 21 MCP tools
 * to the backend's REST API over HTTP.
 *
 * Required environment variables:
 *   WFT_API_URL  - Base URL of the REST API (e.g., http://localhost:3000
 *                  or http://your-server.local:3000). Required — no default.
 *
 * Bearer token (#810): resolved with precedence
 *   1. env `WFT_API_KEY`              (explicit operator override)
 *   2. the CLI credentials TOML file  (written by `tasks login` / `tasks setup`)
 *   3. fail clearly
 * The resolved token is sent by the bridge's REST client as
 * `Authorization: Bearer <token>` (no token is persisted in claude.json).
 */

/**
 * Read the bearer token from the SAME credentials TOML file that
 * `tasks login` / `tasks setup` write. Delegates path resolution and TOML
 * parsing to `src/cli/auth/credentials.ts` — the exclusive owner of that
 * file's lifecycle — so the bridge never hand-rolls TOML parsing. Returns
 * the active token, or `null` when the file is absent / has no usable token.
 */
function readTokenFromCredentialsFile(): string | null {
  const creds = readCredentials();
  if (creds === null) return null;
  const token = creds.active.token;
  return token && token.trim() !== '' ? token : null;
}

/**
 * Validate the config the remote MCP needs. Returns the resolved values on
 * success or an Error describing exactly which variable was missing/invalid.
 * Exported so unit tests can exercise the fail-fast paths without spawning
 * the full MCP server.
 *
 * `apiKey` (the bearer token) is resolved with precedence (#810):
 *   env `WFT_API_KEY` → credentials TOML file → throw.
 * `readCredsToken` is injectable so the precedence ladder is unit-testable
 * without touching the real on-disk credentials file.
 */
export function resolveRemoteConfig(
  env: NodeJS.ProcessEnv = process.env,
  readCredsToken: () => string | null = readTokenFromCredentialsFile,
): {
  apiUrl: string;
  apiKey: string;
} {
  const apiUrl = env['WFT_API_URL'];
  const envKey = env['WFT_API_KEY'];

  if (!apiUrl || apiUrl.trim() === '') {
    throw new Error(
      'WFT_API_URL must be set when running the remote MCP server ' +
        '(e.g., http://localhost:3000 or http://your-server.local:3000). ' +
        'No default is provided to avoid silently connecting to the wrong host.',
    );
  }

  // Precedence: env override wins; otherwise read the credentials file the
  // CLI login/setup flow persists the PAT to.
  let apiKey: string | undefined;
  if (envKey && envKey.trim() !== '') {
    apiKey = envKey;
  } else {
    apiKey = readCredsToken() ?? undefined;
  }

  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'No API token found for the remote MCP server. Set WFT_API_KEY, or run ' +
        `\`tasks login\` to write a token to the credentials file (${getCredentialsPath()}).`,
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
