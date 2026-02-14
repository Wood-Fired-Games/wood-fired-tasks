import { initDatabase } from './db/database.js';
import { runMigrations } from './db/migrate.js';
import { ProjectRepository } from './repositories/project.repository.js';
import { TaskRepository } from './repositories/task.repository.js';
import { DependencyRepository } from './repositories/dependency.repository.js';
import { CommentRepository } from './repositories/comment.repository.js';
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
  workflowEngine: WorkflowEngine;
}

/**
 * Initialize the application with database, repositories, and services
 */
export async function createApp(dbPath?: string): Promise<App> {
  // Initialize database
  const db = initDatabase(dbPath || './data/tasks.db');

  // Run migrations
  await runMigrations(db);

  // Create repositories
  const projectRepo = new ProjectRepository(db);
  const taskRepo = new TaskRepository(db);
  const dependencyRepo = new DependencyRepository(db);
  const commentRepo = new CommentRepository(db);

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

  return {
    db,
    projectService,
    taskService,
    dependencyService,
    commentService,
    workflowEngine,
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
