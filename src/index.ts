import { initDatabase } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { parseApiKeyEntries } from './config/env.js';
import { resolveDbPath } from './config/db-path.js';
import { seedIdentities } from './services/identity-seeder.js';
import { ProjectRepository } from './repositories/project.repository.js';
import { TaskRepository } from './repositories/task.repository.js';
import { DependencyRepository } from './repositories/dependency.repository.js';
import { CommentRepository } from './repositories/comment.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { ApiTokenRepository } from './repositories/api-token.repository.js';
import { WsjfHistoryRepository } from './repositories/wsjf-history.repository.js';
import { ProjectCharterHistoryRepository } from './repositories/project-charter-history.repository.js';
import { ProjectService } from './services/project.service.js';
import { TaskService } from './services/task.service.js';
import { backfillJobSizes } from './services/job-size-backfill.js';
import { DependencyService } from './services/dependency.service.js';
import { CommentService } from './services/comment.service.js';
import { TopologyService } from './services/topology.service.js';
import { DependencyGraphService } from './services/dependency-graph.service.js';
import { WorkflowEngine } from './services/workflow-engine.js';
import { createSettingsRepository } from './repositories/settings.repository.js';
import { createSettingsService, type SettingsService } from './services/settings.service.js';
import {
  createModelCatalogService,
  type ModelCatalogService,
} from './services/model-catalog.service.js';
import { eventBus } from './events/event-bus.js';
import { type OidcConfig } from './services/oidc-client.js';
import { discoverOidcWithRetry } from './services/oidc-boot.js';
import { startCleanup as startDeviceFlowCleanup } from './services/device-flow-store.js';
import type Database from './db/driver.js';
import { isMain } from './utils/is-main.js';

/**
 * Task #357: OIDC subsystem state captured at boot, surfaced on
 * `/health/detailed` so a discovery failure is a loud, queryable signal
 * rather than a silent 501 or a crash-looped process.
 *
 *   - `disabled`  — OIDC_ISSUER_URL unset. /auth/* serve the 501 stub by design.
 *   - `ready`     — discovery succeeded; the real auth routes are live.
 *   - `degraded`  — OIDC was configured but discovery failed after all retry
 *                   attempts. The server booted anyway (PAT/legacy auth still
 *                   works); OIDC login is unavailable until a restart re-runs
 *                   discovery. `error`/`attempts` explain why and how hard we tried.
 */
export type OidcStatus =
  | { state: 'disabled' }
  | { state: 'ready'; issuer: string }
  | { state: 'degraded'; issuer: string; error: string; attempts: number };

/**
 * Application interface returned by createApp
 */
export interface App {
  db: Database.Database;
  projectService: ProjectService;
  taskService: TaskService;
  dependencyService: DependencyService;
  commentService: CommentService;
  /**
   * Wave 4.1 (#318): per-project FLAT/DAG/DAG_CYCLIC classifier surfaced via
   * the `topology_check` MCP tool and `tasks topology` CLI. Pure read-only
   * over `task_dependencies` rows — no schema additions, no writes.
   */
  topologyService: TopologyService;
  /**
   * Task #342: builds the tree/graph/text shapes for the Agent Overview
   * dashboard's dependency-graph panel. Reads-only — performs a single
   * tasks query and a single task_dependencies query per request and
   * composes the requested shape in-memory.
   */
  dependencyGraphService: DependencyGraphService;
  /**
   * Configurable Task Models (Task 13): the database-wide model-policy default
   * owner (task #916). Backs GET|PUT /api/v1/settings/model-policy and the
   * `get/set_model_defaults` MCP tools.
   */
  settingsService: SettingsService;
  /**
   * Configurable Task Models (Task 13): runtime Claude-model-catalog discovery
   * with a TTL cache + static fallback (task #917). Backs GET /api/v1/models
   * and the `list_models` MCP tool. Never throws — degrades to the static
   * fallback (`stale: true`) when ANTHROPIC_API_KEY is absent / the Models API
   * is unreachable.
   */
  modelCatalogService: ModelCatalogService;
  /**
   * Identity-foundation repositories (Phase 27) decorated onto the Fastify
   * instance by `createServer` so the Phase 28 auth chain at
   * `src/api/plugins/auth/index.ts` can call `findLegacyByDisplayName` /
   * `findByHash` per request without re-constructing per-request prepared
   * statements.
   */
  userRepository: UserRepository;
  apiTokenRepository: ApiTokenRepository;
  workflowEngine: WorkflowEngine;
  /**
   * Phase 29 Plan 08: OIDC client Configuration from `initOidc(env)`, or
   * `null` when OIDC is intentionally disabled (no OIDC_ISSUER_URL).
   *
   * Lifecycle:
   *   - null → `createServer` registers the 501 stub at /auth/*.
   *   - non-null → `createServer` registers the real authRoutes plugin
   *     with this config (and the configured redirect URI + scopes).
   *
   * Task #357: discovery failure at boot NO LONGER exits the process. After
   * bounded-retry backoff, a persistent failure leaves this `null` and sets
   * `oidcStatus` to `degraded` — the server boots in degraded mode instead of
   * crash-looping. See the boot block in `createApp` below.
   */
  oidcConfig: OidcConfig | null;
  /**
   * Task #357: coarse OIDC subsystem state for `/health/detailed`. Decoupled
   * from `oidcConfig` (which is null in BOTH disabled and degraded modes) so
   * an operator can tell "OIDC is off by design" apart from "OIDC is broken".
   */
  oidcStatus: OidcStatus;
  /**
   * Tear down everything `createApp` started: stops the WorkflowEngine
   * (releasing its EventBus subscription) and closes the SQLite handle.
   *
   * task #257: tests previously closed only the DB, leaving the WorkflowEngine
   * subscribed to `task.status_changed` on the singleton EventBus. Every
   * `createTestApp` call therefore added another listener and after ~10 tests
   * Node emitted `MaxListenersExceededWarning`. Use this from `afterEach`
   * (or any callsite that owns the App lifetime) instead of `app.db.close()`
   * directly so cleanup stays symmetric with `createApp`.
   *
   * Idempotent — safe to call multiple times.
   */
  dispose: () => void;
}

/**
 * Initialize the application with database, repositories, and services
 */
export async function createApp(dbPath?: string): Promise<App> {
  // Initialize database. When no explicit dbPath is threaded in, fall back to
  // the unified resolver (env > legacy-adopt > app-data default) so this
  // factory never opens a divergent cwd-relative ./data/tasks.db.
  const db = initDatabase(dbPath || resolveDbPath());

  // Log the resolved DB path once at boot. This is the single most useful
  // diagnostic for "which database did this process actually open?" — the
  // question that turned the 2026-05-25 incident into a multi-hour
  // investigation. Skipped for the in-memory test DB to keep test output clean.
  if (db.name !== ':memory:') {
    console.error(JSON.stringify({ level: 'info', msg: 'db.opened', path: db.name }));
  }

  // Run migrations
  await runMigrations(db);

  // Phase 27 (Plan 6): seed legacy + service-account identities. Idempotent --
  // re-runs are zero-cost no-ops. parseApiKeyEntries accepts undefined and
  // returns []; the slack-bot row is seeded unconditionally regardless.
  seedIdentities(db, parseApiKeyEntries(process.env['API_KEYS']));

  // Phase 29 Plan 08 / Task #357 — OIDC discovery (bounded-retry, non-fatal).
  //   - Disabled (no OIDC_ISSUER_URL): logs `oidc.disabled`, status `disabled`;
  //     createServer registers the 501 stub at /auth/*.
  //   - Success (possibly after retries): logs `oidc.ready { issuer, attempts }`,
  //     status `ready`; createServer registers the full authRoutes plugin.
  //   - Persistent failure: logs `oidc.discovery_failed` with an actionable
  //     message and boots in DEGRADED mode (status `degraded`, oidcConfig null
  //     → 501 stub). We DO NOT `process.exit(78)` anymore: a transient network
  //     blip or a not-yet-up network stack at systemd boot must not crash-loop
  //     the tracker. Each failed attempt logs `oidc.discovery_retry`.
  //
  // We use console.error with a small JSON shape here because the Fastify
  // request-scoped logger is not yet constructed at this boot stage. The
  // shape mirrors pino's level/msg convention so downstream log aggregators
  // can ingest it without a separate parser.
  //
  // IMPORTANT: probe `process.env.OIDC_ISSUER_URL` BEFORE touching the
  // `config` Proxy. The Proxy lazy-loads the full Zod-validated config on
  // first access, which would otherwise force every `createApp()` /
  // `createTestApp()` caller — including pure service-layer tests that
  // never need OIDC or full env validation — to set API_KEYS up front.
  // Reading the bare env var keeps the disabled-mode path zero-impact for
  // unrelated callers (matches the old `parseApiKeyEntries(process.env.API_KEYS)`
  // pattern earlier in this function).
  let oidcConfig: OidcConfig | null = null;
  let oidcStatus: OidcStatus = { state: 'disabled' };
  const issuerEnv = process.env['OIDC_ISSUER_URL'];
  if (issuerEnv && issuerEnv.length > 0) {
    // OIDC is requested — NOW load the validated config (this triggers the
    // env schema's all-or-nothing OIDC refine AND validates API_KEYS etc.).
    const { config } = await import('./config/env.js');
    const result = await discoverOidcWithRetry(config, {
      maxAttempts: config.OIDC_DISCOVERY_MAX_ATTEMPTS,
      baseDelayMs: config.OIDC_DISCOVERY_BASE_DELAY_MS,
      maxDelayMs: config.OIDC_DISCOVERY_MAX_DELAY_MS,
      onRetry: ({ attempt, delayMs, error }) => {
        console.error(
          JSON.stringify({
            level: 'warn',
            msg: 'oidc.discovery_retry',
            issuer: config.OIDC_ISSUER_URL,
            attempt,
            nextDelayMs: delayMs,
            err: error.message,
          }),
        );
      },
    });
    const issuer = config.OIDC_ISSUER_URL as string;
    if (result.ok) {
      oidcConfig = result.config;
      oidcStatus = { state: 'ready', issuer };
      console.error(
        JSON.stringify({
          level: 'info',
          msg: 'oidc.ready',
          issuer,
          attempts: result.attempts,
        }),
      );
    } else {
      // Persistent failure — boot DEGRADED rather than exit. oidcConfig stays
      // null so /auth/* falls back to the 501 stub; oidcStatus carries the
      // reason so /health/detailed (and operators) see it loudly.
      oidcStatus = {
        state: 'degraded',
        issuer,
        error: result.error.message,
        attempts: result.attempts,
      };
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'oidc.discovery_failed',
          issuer,
          attempts: result.attempts,
          err: result.error.message,
          action:
            'Server booted in DEGRADED mode: OIDC login is unavailable but ' +
            'PAT/legacy auth still works. Check IdP reachability + network, ' +
            'then restart to re-run discovery. /health/detailed reports oidc=degraded.',
        }),
      );
    }
  } else {
    console.error(JSON.stringify({ level: 'info', msg: 'oidc.disabled' }));
  }

  // Create repositories
  const projectRepo = new ProjectRepository(db);
  const taskRepo = new TaskRepository(db);
  const dependencyRepo = new DependencyRepository(db);
  const commentRepo = new CommentRepository(db);
  // Phase 28 (Plan 28-04): identity repositories — required by the auth
  // chain plugin's PAT and legacy strategies. Constructed once here so the
  // prepared statements are cached for the entire process lifetime.
  const userRepository = new UserRepository(db);
  const apiTokenRepository = new ApiTokenRepository(db);
  // WSJF (#628): append-only score-history repo. Shares the SAME `db` handle
  // as TaskRepository so the component write + history append commit in one
  // `db.transaction(...)` (see TaskService.appendWsjfHistory).
  const wsjfHistoryRepo = new WsjfHistoryRepository(db);
  // WSJF (#642): append-only project_charter_history writer. Shares the SAME
  // `db` handle as ProjectRepository so a charter overwrite snapshots the prior
  // charter and replaces it in one `db.transaction(...)`.
  const charterHistoryRepo = new ProjectCharterHistoryRepository(db);

  // Create services
  const projectService = new ProjectService(projectRepo, {
    charterHistory: charterHistoryRepo,
    db,
  });
  const taskService = new TaskService(taskRepo, projectRepo, db, wsjfHistoryRepo);

  // Guaranteed-task-sizing (#992, design spec §5): idempotent boot sweep.
  // The earliest point both `taskService` (the size-only `autoSizeTask`
  // writer + its wired `boot_sweep` audit hook) and `taskRepo` (the
  // NULL-size candidate scan) exist — this is the boot-step the spec wires
  // "immediately after seedIdentities" (line ~157), deferred only to here
  // because the sweep needs the service. Backfills `wsjf_job_size` for every
  // non-done/non-closed task left sizeless by the migration era so
  // `resolve_model`'s `byCategory` routing engages on the live backlog. ONE
  // db.transaction per row (in `autoSizeTask`), so a mid-sweep failure on one
  // row leaves previously committed rows intact; idempotent on re-boot.
  backfillJobSizes(taskService, taskRepo);

  const dependencyService = new DependencyService(dependencyRepo, taskRepo);
  const commentService = new CommentService(commentRepo, taskRepo);
  const topologyService = new TopologyService(taskRepo, dependencyRepo);
  // N6: pass the better-sqlite3 handle so the bulk reads (count + paginated
  // tasks + dependencies findAll) run inside a snapshot-isolated
  // `db.transaction(() => {})()`. Service-layer unit tests still construct
  // without `db` — the in-memory single-threaded SQLite they use makes the
  // race impossible.
  const dependencyGraphService = new DependencyGraphService(
    taskRepo,
    dependencyRepo,
    projectRepo,
    db,
  );

  // Configurable Task Models (Task 13). The settings service owns the
  // database-wide model-policy default over the `app_settings` singleton row;
  // the model-catalog service discovers the live Claude model catalog. The
  // catalog's `apiKey` is read from ANTHROPIC_API_KEY — when absent (e.g. CI /
  // tests) the service serves the static fallback with `stale: true` and never
  // throws, so no env wiring is required for the route to function.
  const settingsService = createSettingsService(createSettingsRepository(db));
  const modelCatalogService = createModelCatalogService({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });

  // Create and start WorkflowEngine (with db for transaction atomicity)
  const workflowEngine = new WorkflowEngine(taskService, taskRepo, dependencyRepo, eventBus, db);
  workflowEngine.start();

  // Phase 30 Plan 08 — start the device-flow store's periodic cleanup
  // exactly once at boot. The cleanup interval prunes expired sessions
  // every CLEANUP_TICK_MS so the in-memory maps don't grow unboundedly
  // in long-lived processes. The interval is `.unref()`'d inside
  // startCleanup() so a stray test that never calls dispose() doesn't
  // keep vitest alive, but dispose() ALSO clears the interval explicitly
  // to release the handle the moment the app shuts down (#T-30-08-01).
  //
  // The cleanup is wired UNCONDITIONALLY — both OIDC-on and OIDC-off
  // modes share the same in-memory device-flow store. In OIDC-off mode
  // the maps stay empty (the disabled-stub never calls createSession),
  // so the cleanup tick is a no-op; the cost is one timer per process.
  const deviceFlowCleanup = startDeviceFlowCleanup();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Stop the WorkflowEngine FIRST so it unsubscribes from the singleton
    // EventBus before the DB it relies on is gone. Order matters: a queued
    // event handler that fires post-close would otherwise hit a closed db.
    workflowEngine.stop();
    // Plan 30-08 — stop the device-flow cleanup interval. Idempotent: the
    // .stop() handle returned from startCleanup() guards against double-
    // calls internally so a sibling dispose path that also tears down the
    // store doesn't error.
    deviceFlowCleanup.stop();
    if (db.open) {
      db.close();
    }
  };

  return {
    db,
    projectService,
    taskService,
    dependencyService,
    commentService,
    topologyService,
    dependencyGraphService,
    settingsService,
    modelCatalogService,
    userRepository,
    apiTokenRepository,
    workflowEngine,
    oidcConfig,
    oidcStatus,
    dispose,
  };
}

/**
 * Create test app with in-memory database
 */
export async function createTestApp(): Promise<App> {
  return createApp(':memory:');
}

/**
 * CLI entry point
 */
if (isMain(import.meta.url)) {
  const app = await createApp();
  console.log('Wood Fired Tasks initialized');
  app.db.close();
}
