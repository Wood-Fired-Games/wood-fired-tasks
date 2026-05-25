import { initDatabase } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { parseApiKeyEntries } from './config/env.js';
import { seedIdentities } from './services/identity-seeder.js';
import { ProjectRepository } from './repositories/project.repository.js';
import { TaskRepository } from './repositories/task.repository.js';
import { DependencyRepository } from './repositories/dependency.repository.js';
import { CommentRepository } from './repositories/comment.repository.js';
import { UserRepository } from './repositories/user.repository.js';
import { ApiTokenRepository } from './repositories/api-token.repository.js';
import { ProjectService } from './services/project.service.js';
import { TaskService } from './services/task.service.js';
import { DependencyService } from './services/dependency.service.js';
import { CommentService } from './services/comment.service.js';
import { TopologyService } from './services/topology.service.js';
import { DependencyGraphService } from './services/dependency-graph.service.js';
import { WorkflowEngine } from './services/workflow-engine.js';
import { eventBus } from './events/event-bus.js';
import { initOidc, type OidcConfig } from './services/oidc-client.js';
import { startCleanup as startDeviceFlowCleanup } from './services/device-flow-store.js';
import type Database from 'better-sqlite3';
import { isMain } from './utils/is-main.js';

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
   * Discovery failure at boot is mapped to `process.exit(78)` (or, in
   * NODE_ENV=test, a thrown Error so the test process is not killed) —
   * see the boot block in `createApp` below.
   */
  oidcConfig: OidcConfig | null;
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
  // Initialize database
  const db = initDatabase(dbPath || './data/tasks.db');

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
  seedIdentities(db, parseApiKeyEntries(process.env.API_KEYS));

  // Phase 29 Plan 08 — OIDC discovery.
  //   - Returns null when OIDC is intentionally disabled (no OIDC_ISSUER_URL).
  //     Boot logs `oidc.disabled` and continues; createServer will register
  //     the 501 stub at /auth/*.
  //   - Returns a Configuration on success. Boot logs `oidc.ready { issuer }`;
  //     createServer registers the full authRoutes plugin.
  //   - THROWS on discovery failure (configured-but-broken). Boot logs
  //     `oidc.discovery_failed { issuer, err }` and maps to process.exit(78)
  //     (EX_CONFIG). In NODE_ENV=test we rethrow instead so tests can catch
  //     the failure without killing the test process.
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
  const issuerEnv = process.env.OIDC_ISSUER_URL;
  if (issuerEnv && issuerEnv.length > 0) {
    // OIDC is requested — NOW load the validated config (this triggers the
    // env schema's all-or-nothing OIDC refine AND validates API_KEYS etc.).
    const { config } = await import('./config/env.js');
    try {
      oidcConfig = await initOidc(config);
      // initOidc cannot return null on this branch (issuer is set), but the
      // type narrows the same way either way.
      console.error(
        JSON.stringify({
          level: 'info',
          msg: 'oidc.ready',
          issuer: config.OIDC_ISSUER_URL,
        }),
      );
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'oidc.discovery_failed',
          issuer: config.OIDC_ISSUER_URL,
          err: errMessage,
        }),
      );
      // Close the DB so the failure path does not leak the handle.
      if (db.open) db.close();
      if (config.NODE_ENV === 'test') throw err;
      process.exit(78);
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

  // Create services
  const projectService = new ProjectService(projectRepo);
  const taskService = new TaskService(taskRepo, projectRepo);
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

  // Create and start WorkflowEngine (with db for transaction atomicity)
  const workflowEngine = new WorkflowEngine(
    taskService,
    taskRepo,
    dependencyRepo,
    eventBus,
    db
  );
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
    userRepository,
    apiTokenRepository,
    workflowEngine,
    oidcConfig,
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
