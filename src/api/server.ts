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
import taskRoutes from './routes/tasks/index.js';
import projectRoutes from './routes/projects/index.js';
import healthRoutes from './routes/health.js';
import { errorHandler } from './hooks/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';

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

  // Set custom error handler (must be set before routes)
  server.setErrorHandler(errorHandler);

  // Register Swagger/OpenAPI documentation (must be before routes to capture schemas)
  await registerSwagger(server);

  // Register public health check route (no auth required)
  await server.register(healthRoutes, { prefix: '/health' });

  // Register routes under /api/v1 with auth protection
  await server.register(
    async (api) => {
      // Read API keys from environment
      const apiKeysRaw = process.env.API_KEYS || '';
      const validKeys = new Set(
        apiKeysRaw
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      );

      if (validKeys.size === 0) {
        api.log.warn('No API keys configured in API_KEYS env var. All API requests will be rejected.');
      }

      // Add preHandler hook directly to this scope
      api.addHook('preHandler', async (request, reply) => {
        const apiKey = request.headers['x-api-key'];

        if (!apiKey) {
          return reply.code(401).send({
            error: 'UNAUTHORIZED',
            message: 'Missing API key. Provide X-API-Key header.',
          });
        }

        if (!validKeys.has(apiKey as string)) {
          return reply.code(401).send({
            error: 'UNAUTHORIZED',
            message: 'Invalid API key.',
          });
        }
      });

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
