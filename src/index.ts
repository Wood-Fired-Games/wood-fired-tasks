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
import { WorkflowEngine } from './services/workflow-engine.js';
import { eventBus } from './events/event-bus.js';
import type Database from 'better-sqlite3';

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

  // Run migrations
  await runMigrations(db);

  // Phase 27 (Plan 6): seed legacy + service-account identities. Idempotent --
  // re-runs are zero-cost no-ops. parseApiKeyEntries accepts undefined and
  // returns []; the slack-bot row is seeded unconditionally regardless.
  seedIdentities(db, parseApiKeyEntries(process.env.API_KEYS));

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

  // Create and start WorkflowEngine (with db for transaction atomicity)
  const workflowEngine = new WorkflowEngine(
    taskService,
    taskRepo,
    dependencyRepo,
    eventBus,
    db
  );
  workflowEngine.start();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    // Stop the WorkflowEngine FIRST so it unsubscribes from the singleton
    // EventBus before the DB it relies on is gone. Order matters: a queued
    // event handler that fires post-close would otherwise hit a closed db.
    workflowEngine.stop();
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
    userRepository,
    apiTokenRepository,
    workflowEngine,
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
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  console.log('Wood Fired Bugs initialized');
  app.db.close();
}
