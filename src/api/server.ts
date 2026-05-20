import Fastify, { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import fastifySSE, { SSEPluginOptions } from '@fastify/sse';
import rateLimit from '@fastify/rate-limit';
import { createApp, App } from '../index.js';
import { config } from '../config/env.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { CommentService } from '../services/comment.service.js';
import { SSEManager } from '../events/sse-manager.js';
import { IdempotencyService } from '../services/idempotency.service.js';
import { ClaimReleaseService } from '../services/claim-release.service.js';
import { SlackService } from '../services/slack.service.js';
import { eventBus } from '../events/event-bus.js';
import { registerTasksCommand } from '../slack/commands/tasks-command.js';
import { UserIdentityCache } from '../slack/user-identity.js';
import { SlackNotifier } from '../slack/notifier.js';
import { SlackChannelSubscriptionRepository } from '../slack/repositories/channel-subscription.repository.js';
import taskRoutes from './routes/tasks/index.js';
import projectRoutes from './routes/projects/index.js';
import dependencyRoutes from './routes/dependencies/index.js';
import commentRoutes from './routes/comments/index.js';
import eventsRoute from './routes/events.js';
import healthRoutes from './routes/health.js';
import { errorHandler } from './hooks/error-handler.js';
import { registerSwagger } from './plugins/swagger.js';
import authPlugin from './plugins/auth.js';

/**
 * Pino redact configuration applied to the Fastify logger in every
 * environment. Exported so tests can verify the redaction paths without
 * spinning up a full server.
 */
export const LOGGER_REDACT_CONFIG = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    '*.password',
    '*.secret',
    '*.apiKey',
    '*.token',
  ],
  censor: '[REDACTED]',
} as const;

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
    // Timeout configurations to prevent hung requests
    connectionTimeout: config.CONNECTION_TIMEOUT, // Socket inactivity timeout (2 min)
    requestTimeout: config.REQUEST_TIMEOUT, // Maximum time for entire request (1 min)
    keepAliveTimeout: config.KEEP_ALIVE_TIMEOUT, // Time to keep idle connections alive (10 sec)
    forceCloseConnections: 'idle', // Close idle connections on shutdown (requires Node >= 18.2.0)
    genReqId: () => randomUUID(), // UUID v4 request IDs for end-to-end tracing
    requestIdHeader: false, // Security: do not trust caller-supplied request IDs
    logger: {
      name: 'wood-fired-bugs',
      level: config.LOG_LEVEL,
      // Redact sensitive fields in EVERY environment so x-api-key (and other
      // secret-bearing fields) never appear in logs, including tests and dev.
      // Task #182: ensure invalid auth attempts and successful-request logs
      // both elide the supplied key value.
      redact: {
        paths: [...LOGGER_REDACT_CONFIG.paths],
        censor: LOGGER_REDACT_CONFIG.censor,
      },
      transport:
        config.NODE_ENV === 'development'
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

  // Stamp X-Request-ID on every response for client-side tracing
  server.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.id);
  });

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

  // Create SlackService (no-op if Slack tokens absent)
  const slackService = new SlackService(
    config.SLACK_BOT_TOKEN,
    config.SLACK_APP_TOKEN,
    server.log
  );

  // Cleanup on server close
  server.addHook('onClose', async () => {
    clearInterval(idempotencyCleanupInterval);
    claimReleaseService.stop();
    sseManager.shutdown();
    app.workflowEngine.stop();
    await slackService.stop();
  });

  // Set custom error handler (must be set before routes)
  server.setErrorHandler(errorHandler);

  // Register Swagger/OpenAPI documentation (must be before routes to capture schemas)
  await registerSwagger(server);

  // Register @fastify/sse plugin (must be before routes that use SSE)
  await server.register(fastifySSE as any, {
    heartbeatInterval: 30000,
  } as SSEPluginOptions);

  // Register global rate limiting (task #182: defense against brute-force
  // and high-volume abuse). /health is allow-listed so liveness/readiness
  // probes never consume the budget. Defaults are intentionally high to
  // avoid disrupting the existing test suite, which exercises many
  // server.inject calls from 127.0.0.1; operators tune via env.
  await server.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 1000),
    timeWindow: process.env.RATE_LIMIT_TIME_WINDOW ?? '1 minute',
    allowList: (req) =>
      req.url === '/health' || req.url.startsWith('/health/'),
    // The error returned here is thrown by @fastify/rate-limit; the project's
    // custom errorHandler reads `statusCode` and `code` to shape the JSON
    // response. We attach both so the response surfaces as
    // { error: 'TOO_MANY_REQUESTS', message: ... } with HTTP 429.
    errorResponseBuilder: (_req, ctx) => {
      const err = new Error(
        `Rate limit exceeded, retry in ${ctx.after}`,
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = ctx.statusCode;
      err.code = 'TOO_MANY_REQUESTS';
      return err;
    },
  });

  // Register public health check route (no auth required)
  await server.register(healthRoutes, { prefix: '/health' });

  // Register routes under /api/v1 with auth protection
  await server.register(
    async (api) => {
      // Centralized auth (task #182): single canonical plugin. Hardens
      // production keys, uses constant-time comparison, logs invalid
      // attempts without leaking the supplied key.
      await api.register(authPlugin);

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

  // Start Slack connection (no-op if tokens absent, must be after onClose hook registration)
  await slackService.start();

  // Register slash command handlers and notification pipeline if Slack is connected
  const slackApp = slackService.getApp();
  if (slackApp) {
    const identityCache = new UserIdentityCache(slackApp.client);
    const subscriptionRepo = new SlackChannelSubscriptionRepository(app.db);

    // Register slash command handlers (subscribe/unsubscribe now have repo access)
    registerTasksCommand(
      slackApp,
      {
        taskService: app.taskService,
        projectService: app.projectService,
        dependencyService: app.dependencyService,
        commentService: app.commentService,
      },
      identityCache,
      subscriptionRepo
    );

    // Create and start notification pipeline
    const slackNotifier = new SlackNotifier(
      slackApp.client,
      subscriptionRepo,
      app.projectService,
      server.log
    );
    slackNotifier.start();

    // Register shutdown hook for notifier (additive — Fastify executes all onClose hooks)
    server.addHook('onClose', async () => {
      slackNotifier.stop();
    });

    server.log.info('Slack /tasks command handler registered');
    server.log.info('Slack notification pipeline started');
  }

  return { server, app };
}
