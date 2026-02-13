import Fastify, { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createApp, App } from '../index.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import authPlugin from './plugins/auth.js';
import taskRoutes from './routes/tasks/index.js';
import projectRoutes from './routes/projects/index.js';

// Extend Fastify instance with our service decorations
declare module 'fastify' {
  interface FastifyInstance {
    taskService: TaskService;
    projectService: ProjectService;
    db: Database.Database;
  }
}

/**
 * Create Fastify server with Zod type provider and Phase 1 services
 */
export async function createServer(options?: { dbPath?: string }): Promise<{
  server: FastifyInstance;
  app: App;
}> {
  // Initialize Phase 1 services
  const app = await createApp(options?.dbPath);

  // Create Fastify instance with logger
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: { colorize: true },
            }
          : undefined,
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Set Zod validator and serializer
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  // Decorate server with Phase 1 services
  server.decorate('taskService', app.taskService);
  server.decorate('projectService', app.projectService);
  server.decorate('db', app.db);

  // Register routes under /api/v1 with auth protection
  await server.register(
    async (api) => {
      // Register auth plugin (applies to all routes in this scope)
      await api.register(authPlugin);

      // Register task routes
      await api.register(taskRoutes, { prefix: '/tasks' });

      // Register project routes
      await api.register(projectRoutes, { prefix: '/projects' });
    },
    { prefix: '/api/v1' }
  );

  return { server, app };
}

/**
 * Start the server (used as entry point, not in tests)
 */
export async function startServer(): Promise<void> {
  const { server } = await createServer();

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  await server.listen({ port, host });
  server.log.info(`Server listening on ${host}:${port}`);
}
