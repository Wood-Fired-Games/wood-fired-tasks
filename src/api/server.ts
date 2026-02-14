import Fastify, { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import fastifySSE, { SSEPluginOptions } from '@fastify/sse';
import { createApp, App } from '../index.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { CommentService } from '../services/comment.service.js';
import { SSEManager } from '../events/sse-manager.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { ClaimReleaseService } from '../services/claim-release.service.js';
import { eventBus } from '../events/event-bus.js';
import taskRoutes from './routes/tasks/index.js';
import projectRoutes from './routes/projects/index.js';
import dependencyRoutes from './routes/dependencies/index.js';
import commentRoutes from './routes/comments/index.js';
import eventsRoute from './routes/events.js';
import healthRoutes from './routes/health.js';
import { errorHandler } from './hooks/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';

// Extend Fastify instance with our service decorations
declare module 'fastify' {
  interface FastifyInstance {
    taskService: TaskService;
    projectService: ProjectService;
    dependencyService: DependencyService;
    commentService: CommentService;
    idempotencyService: IdempotencyService;
    db: Database.Database;
    sseManager: SSEManager;
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
      name: 'wood-fired-bugs',
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
  server.decorate('dependencyService', app.dependencyService);
  server.decorate('commentService', app.commentService);
  server.decorate('db', app.db);

  // Create and decorate IdempotencyService
  const idempotencyService = new IdempotencyService(app.db);
  server.decorate('idempotencyService', idempotencyService);

  // Create and decorate SSEManager
  const sseManager = new SSEManager();
  server.decorate('sseManager', sseManager);

  // Wire EventBus to SSEManager - subscribe to each event type explicitly
  eventBus.subscribe('task.created', (event) => sseManager.broadcast(event));
  eventBus.subscribe('task.updated', (event) => sseManager.broadcast(event));
  eventBus.subscribe('task.deleted', (event) => sseManager.broadcast(event));
  eventBus.subscribe('task.status_changed', (event) => sseManager.broadcast(event));
  eventBus.subscribe('task.claimed', (event) => sseManager.broadcast(event));
  eventBus.subscribe('project.created', (event) => sseManager.broadcast(event));
  eventBus.subscribe('project.updated', (event) => sseManager.broadcast(event));
  eventBus.subscribe('project.deleted', (event) => sseManager.broadcast(event));

  // Create and start ClaimReleaseService for auto-releasing stale claims
  const claimReleaseService = new ClaimReleaseService(app.db);
  claimReleaseService.start(); // Sweep every 5 minutes by default

  // Start periodic idempotency key cleanup (every hour)
  const idempotencyCleanupInterval = setInterval(() => {
    idempotencyService.cleanup();
  }, 60 * 60 * 1000);

  // Cleanup on server close
  server.addHook('onClose', async () => {
    clearInterval(idempotencyCleanupInterval);
    claimReleaseService.stop();
    sseManager.shutdown();
  });

  // Set custom error handler (must be set before routes)
  server.setErrorHandler(errorHandler);

  // Register Swagger/OpenAPI documentation (must be before routes to capture schemas)
  await registerSwagger(server);

  // Register @fastify/sse plugin (must be before routes that use SSE)
  await server.register(fastifySSE as any, {
    heartbeatInterval: 30000,
  } as SSEPluginOptions);

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

      // Register dependency routes (nested under tasks)
      await api.register(dependencyRoutes, { prefix: '/tasks' });

      // Register comment routes (nested under tasks)
      await api.register(commentRoutes, { prefix: '/tasks' });

      // Register events route
      await api.register(eventsRoute, { prefix: '/events' });
    },
    { prefix: '/api/v1' }
  );

  return { server, app };
}
