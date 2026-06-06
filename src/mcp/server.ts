import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../db/driver.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { CommentService } from '../services/comment.service.js';
import { TopologyService } from '../services/topology.service.js';
import type { UserRepository } from '../repositories/user.repository.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerDependencyTools } from './tools/dependency-tools.js';
import { registerCommentTools } from './tools/comment-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerHealthTools } from './tools/health-tools.js';
import { registerTopologyTools } from './tools/topology-tools.js';
import { registerWaitForUnblockTools } from './tools/wait-for-unblock-tools.js';
import { registerWsjfTools } from './tools/wsjf-tools.js';
import { TaskRepository } from '../repositories/task.repository.js';
import { DependencyRepository } from '../repositories/dependency.repository.js';
import { WsjfHistoryRepository } from '../repositories/wsjf-history.repository.js';
import { WsjfRescoreRepository } from '../repositories/wsjf-rescore.repository.js';
import { ProjectRepository } from '../repositories/project.repository.js';
import { WsjfRescoreService } from '../services/wsjf-rescore.service.js';
import { WsjfHealthService } from '../services/wsjf-health.service.js';
import { VERSION } from '../utils/version.js';
import {
  EVENTS_RESOURCE_URI,
  EVENTS_RESOURCE_NAME,
  EVENTS_RESOURCE_DESCRIPTION,
  getEventsResourceContent,
} from './resources/events.js';

/**
 * Boot-time context for MCP tool handlers (Phase 31 Plan 03).
 *
 * Threaded into every `register*Tools` call so handlers can inject the
 * resolved actor `user.id` into service-write input objects (the parallel
 * FK columns introduced by migration 009).
 *
 * Defaults to `actorUserId: null` for callers that haven't been updated
 * yet (tests that pre-date Phase 31). Tool handlers treat `null` as "no
 * actor" and write the FK column as NULL, preserving today's behaviour
 * for the still-legacy column-only paths.
 */
export interface McpServerContext {
  /** Resolved user.id for the MCP actor; see src/mcp/identity-resolution.ts. */
  actorUserId: number | null;
  /**
   * Optional UserRepository used by the update_task tool to best-effort
   * resolve `assignee_user_id` from a user-supplied `assignee` email
   * (mirroring the REST PATCH helper from Plan 31-02). Omit when callers
   * don't care about assignee FK resolution (tests, future remote
   * adapters); the handler then leaves the FK column NULL on assignee
   * changes.
   */
  userRepository?: UserRepository;
}

const DEFAULT_CTX: McpServerContext = { actorUserId: null };

/**
 * Create and configure an MCP server instance
 *
 * Factory function that creates an McpServer with 27 tools and 1 resource:
 * - 9 task tools (create, get, update, list, delete, claim, list_subtasks, completion_report, get_subtasks)
 * - 1 wait tool (wait_for_unblock) — Task #455, in-process long-poll on blocked->open
 * - 5 project tools (create, get, update, list, delete)
 * - 3 dependency tools (add, remove, list)
 * - 3 comment tools (add, list, delete)
 * - 1 health tool (check_health)
 * - 1 topology tool (topology_check) — Wave 4.1 (#318), only registered when topologyService is provided
 * - 3 WSJF tools (wsjf_ranking, wsjf_history — #630; rescore_project — #641)
 * - 1 resource (events://stream - SSE event stream discovery)
 *
 * This pattern allows tests to instantiate servers without stdio transport.
 *
 * @param taskService - Service for task operations
 * @param projectService - Service for project operations
 * @param dependencyService - Service for dependency operations
 * @param commentService - Service for comment operations
 * @param db - Database instance for health checks
 * @param ctx - Phase 31 Plan 03: boot-time identity context. Tool handlers
 *   inject `ctx.actorUserId` into service-write input objects. Defaults to
 *   `{ actorUserId: null }` so existing tests that don't pass an explicit
 *   context continue to work — FK columns simply stay NULL for those calls.
 * @returns Configured McpServer instance ready to connect to a transport
 */
export function createMcpServer(
  taskService: TaskService,
  projectService: ProjectService,
  dependencyService: DependencyService,
  commentService: CommentService,
  db: Database,
  ctx: McpServerContext = DEFAULT_CTX,
  // Wave 4.1 (#318): topologyService is optional so the dozens of pre-#318
  // tests that call createMcpServer with the original 5-arg signature keep
  // working. When omitted, the `topology_check` tool is simply not
  // registered for that server instance (production boot always passes it
  // — see src/mcp/index.ts).
  topologyService?: TopologyService,
): McpServer {
  const server = new McpServer({
    name: 'wood-fired-tasks',
    version: VERSION,
  });

  // Register all tools — ctx is threaded into every tool group so create /
  // update / claim / comment handlers can inject ctx.actorUserId into the
  // service-write input objects (Phase 31 Plan 03 Task 2). update_task
  // additionally uses ctx.userRepository for best-effort assignee
  // email-resolution (mirrors REST PATCH from Plan 31-02 Task 3).
  registerTaskTools(server, taskService, projectService, ctx);
  registerProjectTools(server, projectService);
  registerDependencyTools(server, dependencyService);
  registerCommentTools(server, commentService, ctx);
  registerHealthTools(server, db);
  // Task #455: long-poll tool that blocks until a task unblocks. Registered
  // unconditionally (like get_task) since it only needs the in-process
  // TaskService + eventBus singleton.
  registerWaitForUnblockTools(server, taskService);
  if (topologyService) {
    registerTopologyTools(server, topologyService);
  }

  // WSJF 1.10 (#630): register wsjf_ranking + wsjf_history. The RankDeps bundle
  // and the append-only history reader are built from the same `db` handle the
  // rest of the services share (db-backed repositories are stateless prepared-
  // statement holders). `rankFrontier` needs a TopologyService — reuse the one
  // wired at boot when present, otherwise construct an equivalent over fresh
  // db-backed repos so the tool is always available (mirrors how production
  // always passes topologyService via src/mcp/index.ts).
  const wsjfTaskRepo = new TaskRepository(db);
  const wsjfDependencyRepo = new DependencyRepository(db);
  const wsjfTopologyService =
    topologyService ?? new TopologyService(wsjfTaskRepo, wsjfDependencyRepo);
  const wsjfHistoryRepo = new WsjfHistoryRepository(db);
  // WSJF 4.1 (#641): the deterministic rescore engine backing `rescore_project`.
  // Shares the SAME `db` handle as history/runs so a rescore commits the run
  // record, every linked history row, and the component writes atomically.
  const wsjfRescoreService = new WsjfRescoreService({
    db,
    tasks: wsjfTaskRepo,
    projects: new ProjectRepository(db),
    history: wsjfHistoryRepo,
    runs: new WsjfRescoreRepository(db),
    topology: wsjfTopologyService,
  });
  // WSJF 5.1 (#646): the degeneracy / pitfall linter backing `wsjf_health`.
  // Pure read over the same task repo + append-only history reader the rest of
  // the WSJF tools share.
  const wsjfHealthService = new WsjfHealthService({
    tasks: wsjfTaskRepo,
    history: wsjfHistoryRepo,
  });
  registerWsjfTools(server, {
    rank: {
      topology: wsjfTopologyService,
      dependency: dependencyService,
      tasks: wsjfTaskRepo,
    },
    history: wsjfHistoryRepo,
    rescore: wsjfRescoreService,
    health: wsjfHealthService,
  });

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
    },
  );

  return server;
}
