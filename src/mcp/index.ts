import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from '../index.js';
import { createMcpServer } from './server.js';
import { resolveActorUserIdWithPath } from './identity-resolution.js';
import { parseApiKeyEntries } from '../config/env.js';

/**
 * MCP server stdio entry point
 *
 * Initializes the database, services, and MCP server, then connects
 * to stdio transport for communication with MCP clients.
 */
async function main() {
  // Determine database path from environment or use default.
  //
  // DATABASE_PATH is the canonical name (see src/config/env.ts and all CLI
  // commands). DB_PATH is accepted as a deprecated alias for backward
  // compatibility with older ~/.claude.json installs produced by install.sh
  // / install.ps1 before task #217. New installs should set DATABASE_PATH.
  const dbPath =
    process.env.DATABASE_PATH || process.env.DB_PATH || './data/tasks.db';

  // Initialize application (database, repositories, services)
  const app = await createApp(dbPath);

  // Phase 31 Plan 03: resolve the MCP actor's user.id BEFORE creating the
  // MCP server. The resolved id flows into every tool handler via the
  // McpServerContext so that create_task / claim_task / add_comment writes
  // populate the parallel FK columns (created_by_user_id, assignee_user_id,
  // author_user_id) alongside the legacy TEXT columns. See
  // src/mcp/identity-resolution.ts for the precedence (PAT → legacy →
  // mcp-bot service-account fallback).
  //
  // The resolver throws if mcp-bot is not seeded — let it propagate so the
  // mainWithRetry wrapper logs it (to stderr) and the process exits with
  // a clear error. Don't catch + ignore; an MCP boot without a usable
  // actor identity is a bug, not a soft failure.
  const { actorUserId, path: resolutionPath } = resolveActorUserIdWithPath({
    apiKey: process.env.WFB_API_KEY,
    apiTokenRepo: app.apiTokenRepository,
    userRepo: app.userRepository,
    apiKeyEntries: parseApiKeyEntries(process.env.API_KEYS),
  });

  // One-line INFO log so operators can see which credential class
  // authenticated this MCP process. WFB_API_KEY value is NEVER logged —
  // only the resolution path tag (T-31-08 mitigation). console.error so
  // we don't corrupt the JSON-RPC stdout stream (Pitfall 5).
  console.error(
    JSON.stringify({
      level: 'info',
      event: 'mcp.actor_resolved',
      actor_user_id: actorUserId,
      resolution_path: resolutionPath,
    }),
  );

  // Create MCP server with initialized services + boot-time context
  const server = createMcpServer(
    app.taskService,
    app.projectService,
    app.dependencyService,
    app.commentService,
    app.db,
    { actorUserId, userRepository: app.userRepository },
  );

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Log to stderr (stdout reserved for JSON-RPC)
  console.error('Wood Fired Bugs MCP Server running on stdio');
}

/**
 * Returns true for transient SQLite contention errors that are safe to retry.
 */
function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED') ||
    message.includes('BEGIN EXCLUSIVE')
  );
}

/**
 * Wraps main() with retry logic for transient SQLite contention errors.
 *
 * During concurrent MCP server startups, the exclusive migration lock may
 * cause SQLITE_BUSY. Retrying up to 3 times (500ms apart) handles the window
 * between busy_timeout expiry and Claude Code's connection timeout.
 */
async function mainWithRetry(maxAttempts = 3, delayMs = 500): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await main();
      return;
    } catch (err) {
      if (isTransientError(err) && attempt < maxAttempts) {
        console.error(
          `MCP startup attempt ${attempt} failed (transient), retrying...`,
          err instanceof Error ? err.message : String(err)
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
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

// Run main function with retry for transient SQLite contention errors
mainWithRetry().catch((error) => {
  console.error('Fatal error during MCP startup:', error);
  process.exit(1);
});
