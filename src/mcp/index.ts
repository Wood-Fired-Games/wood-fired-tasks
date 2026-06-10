import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp } from '../index.js';
import { createMcpServer } from './server.js';
import { resolveActorUserIdWithPath } from './identity-resolution.js';
import { parseApiKeyEntries } from '../config/env.js';
import { resolveDbPath } from '../config/db-path.js';
import { precomputeHashedEntries } from '../api/plugins/auth/keys.js';
import { triggerUpdateCheck } from '../cli/update/check-writer.js';
import { createModelPolicyService } from '../services/model-policy.service.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { TaskRepository } from '../repositories/task.repository.js';

/**
 * MCP server stdio entry point
 *
 * Initializes the database, services, and MCP server, then connects
 * to stdio transport for communication with MCP clients.
 */
async function main() {
  // Determine database path via the unified resolver (src/config/db-path.ts)
  // so the MCP stdio server opens the EXACT same database as the API server,
  // migration CLI, and every `tasks db*` subcommand. The resolver honours the
  // canonical DATABASE_PATH and the deprecated DB_PATH alias (older
  // ~/.claude.json installs from install.sh / install.ps1 before task #217),
  // then falls back to legacy-adopt ./data/tasks.db (with a one-time warning)
  // or the OS app-data default.
  const dbPath = resolveDbPath();

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
  // WR-06: compute legacy API_KEYS hashes ONCE at boot (mirrors the REST
  // legacy strategy in src/api/plugins/auth/strategies/legacy.ts). The
  // resolver no longer re-hashes per call. Cheap here even though MCP
  // boot only calls resolveActorUserIdWithPath once — it keeps the
  // resolver's contract aligned with the REST path so future callers
  // (tests, multi-instance harnesses) inherit the same discipline.
  //
  // WR-02: WFT_MCP_ALLOW_BAD_PAT=1 is the documented opt-in escape hatch
  // for operators who want to keep MCP booting even when WFT_API_KEY is
  // a PAT that is unknown/revoked/expired or belongs to a disabled user.
  // The default (unset / '0' / anything else) fails closed at the
  // resolver level so a revoked PAT cannot silently demote to mcp-bot
  // and mask a kill-signal.
  const apiKeyEntries = parseApiKeyEntries(process.env['API_KEYS']);
  const hashedEntries = precomputeHashedEntries(apiKeyEntries);
  const allowBadPat = process.env['WFT_MCP_ALLOW_BAD_PAT'] === '1';
  const { actorUserId, path: resolutionPath } = resolveActorUserIdWithPath({
    apiKey: process.env['WFT_API_KEY'],
    apiTokenRepo: app.apiTokenRepository,
    userRepo: app.userRepository,
    hashedEntries,
    allowBadPat,
  });

  // One-line INFO log so operators can see which credential class
  // authenticated this MCP process. WFT_API_KEY value is NEVER logged —
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

  // Configurable Task Models Task 11 (#920): construct the model-policy
  // resolver behind the `resolve_model` tool. Its three lookups are injected:
  //   - getProjectPolicy ← a project's parsed `model_policy` (ProjectRepository
  //     inflates the JSON column to a ModelPolicy | null).
  //   - getGlobalPolicy  ← the database-wide default owned by the settings
  //     service (the SAME instance the API and `get/set_model_defaults` use).
  //   - getTask          ← a task's project membership + WSJF jobSize tier
  //     (the `project_id` / `wsjf_job_size` columns inflated by TaskRepository);
  //     `null` when the task does not exist (task #928 validation).
  //   - projectExists    ← existence guard so a nonexistent project errors
  //     instead of silently resolving the global default (task #928 parity
  //     with the REST route's 404).
  // The repos are built over the SAME `app.db` handle every other service
  // shares (db-backed repos are stateless prepared-statement holders), mirroring
  // how server.ts constructs the WSJF repos.
  const projectRepo = new ProjectRepository(app.db);
  const taskRepo = new TaskRepository(app.db);
  const modelPolicyService = createModelPolicyService({
    projectExists: (projectId) => projectRepo.findById(projectId) != null,
    getProjectPolicy: (projectId) => projectRepo.findById(projectId)?.model_policy ?? null,
    getGlobalPolicy: () => app.settingsService.getModelPolicyDefault(),
    getTask: (taskId) => {
      const task = taskRepo.findById(taskId);
      return task == null
        ? null
        : { project_id: task.project_id, wsjf_job_size: task.wsjf_job_size ?? null };
    },
  });

  // Create MCP server with initialized services + boot-time context
  const server = createMcpServer(
    app.taskService,
    app.projectService,
    app.dependencyService,
    app.commentService,
    app.db,
    { actorUserId, userRepository: app.userRepository },
    // Wave 4.1 (#318): topology classifier behind the `topology_check` tool.
    app.topologyService,
    // Configurable Task Models Task 11 (#920): the three services backing the
    // four model tools (list_models, resolve_model, get/set_model_defaults).
    app.modelCatalogService,
    modelPolicyService,
    app.settingsService,
  );

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  // Phase 4 (#795): fire-and-forget update-available check. Runs OFF the
  // `tasks statusline` render hot path; records "newer version available"
  // into the update-check cache so the status line can READ it later. Gated
  // on isUpdateCheckEnabled() internally, best-effort (never throws), and
  // explicitly NOT awaited so it cannot block or delay MCP boot.
  triggerUpdateCheck();

  // Log to stderr (stdout reserved for JSON-RPC)
  console.error('Wood Fired Tasks MCP Server running on stdio');
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
          err instanceof Error ? err.message : String(err),
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
