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
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import { createApp, App } from '../index.js';
import { config } from '../config/env.js';
import { SESSION_LIFETIME_SECONDS } from '../web/session-constants.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { DependencyGraphService } from '../services/dependency-graph.service.js';
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
import meRoutes from './routes/me/index.js';
import webRoutes from './routes/web/index.js';
import healthRoutes, { detailedHealthRoutes } from './routes/health.js';
import { errorHandler } from './hooks/error-handler.js';
import { registerSwaggerSpec, registerSwaggerUI } from './plugins/swagger.js';
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
    dependencyGraphService: DependencyGraphService;
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
      name: 'wood-fired-tasks',
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
  server.decorate('dependencyGraphService', app.dependencyGraphService);
  server.decorate('commentService', app.commentService);
  server.decorate('db', app.db);

  // Phase 28 (Plan 28-04): identity repositories decorated for the auth
  // chain plugin's per-request PAT lookups (`findByHash`) and legacy
  // principal resolution (`findLegacyByDisplayName`). The matching
  // FastifyInstance augmentation is centralized in `src/types/fastify.d.ts`
  // — DO NOT add them to the local `declare module 'fastify'` block above;
  // TypeScript merges all `interface FastifyInstance` declarations across
  // files and a duplicate here would conflict.
  server.decorate('userRepository', app.userRepository);
  server.decorate('apiTokenRepository', app.apiTokenRepository);

  // Create and decorate IdempotencyService
  const idempotencyService = new IdempotencyService(app.db);
  server.decorate('idempotencyService', idempotencyService);

  // Create and decorate SSEManager
  // task #185: per-key/per-IP/global SSE caps are passed in from env so
  // operators can tune limits without code changes. Defaults are set in
  // the Zod schema (4 / 8 / 200).
  const sseManager = new SSEManager(
    undefined, // maxBufferSize → default
    undefined, // bufferTtlMs → default
    undefined, // heartbeatIntervalMs → default
    undefined, // maxConnectionAgeMs → default
    config.SSE_MAX_CONNECTIONS_PER_KEY,
    config.SSE_MAX_CONNECTIONS_PER_IP,
    config.SSE_MAX_CONNECTIONS
  );
  server.decorate('sseManager', sseManager);

  // Wire EventBus to SSEManager - subscribe to each event type explicitly.
  //
  // task #257: eventBus is a process-wide SINGLETON, so every createServer()
  // call (notably the integration test suite which spins up dozens of Fastify
  // instances) was permanently attaching another 8 listeners — exceeding the
  // default 10-listener threshold and emitting MaxListenersExceededWarning.
  // Capture the unsubscribe handles returned by eventBus.subscribe and tear
  // them down in the server's onClose hook below so each createServer/close
  // cycle is listener-neutral. This also closes a small but real leak in any
  // long-lived process that rebuilds the server (e.g. hot-reload, integration
  // harnesses).
  const sseUnsubscribers: Array<() => void> = [
    eventBus.subscribe('task.created', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('task.updated', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('task.deleted', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('task.status_changed', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('task.claimed', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('project.created', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('project.updated', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('project.deleted', (event) => sseManager.broadcast(event)),
  ];

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
    // task #257: drop our EventBus subscriptions so the singleton emitter
    // does not accumulate listeners across createServer/close cycles.
    for (const unsubscribe of sseUnsubscribers) {
      unsubscribe();
    }
    sseUnsubscribers.length = 0;
  });

  // task #257: from this point on, any thrown error (e.g.
  // `validateApiKeysForProduction` failing inside `authPlugin`) would skip the
  // normal `server.close()` path, leaving the EventBus listeners and other
  // resources allocated above leaked. Wrap the remaining wiring in try/catch
  // and route construction failures through `server.close()` so the onClose
  // hook above runs (sse unsubscribe + claim release stop + workflow stop).
  try {

  // Set custom error handler (must be set before routes)
  server.setErrorHandler(errorHandler);

  // Register Swagger/OpenAPI spec collector (must be before routes so it can
  // capture their schemas). task #185: the spec collector itself does not
  // expose any HTTP endpoint — only `@fastify/swagger-ui` does that, and we
  // register it conditionally below.
  await registerSwaggerSpec(server);

  // task #185: gate Swagger UI / `/docs/json` in production.
  // - Non-production (development, test): expose UI without auth — keeps the
  //   current developer workflow and existing openapi.test.ts assertions.
  // - Production + ENABLE_SWAGGER_IN_PRODUCTION=true: expose UI but require
  //   X-API-Key (same canonical auth plugin used for /api/v1).
  // - Production + default config: do NOT register the UI plugin at all.
  //   `/docs` and `/docs/json` return 404.
  const exposeSwaggerUI =
    config.NODE_ENV !== 'production' || config.ENABLE_SWAGGER_IN_PRODUCTION === true;
  if (exposeSwaggerUI) {
    if (config.NODE_ENV === 'production') {
      await server.register(async (scope) => {
        await scope.register(authPlugin);
        await registerSwaggerUI(scope);
      });
    } else {
      await registerSwaggerUI(server);
    }
  }

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

  // ─── Phase 29 Plan 04 ─── cookie → secure-session → formbody (top level)
  //
  // Registered HERE (above /health and the /api/v1 scope) so:
  //   • Cookie parsing is uniform across web routes (Plan 29-06/29-07) and
  //     the /api/v1 scope (where the Phase 28 auth chain's session strategy
  //     reads `request.session.get('user')`).
  //   • The order avoids Pitfall 5 — secure-session auto-loads
  //     @fastify/cookie if absent; an EXPLICIT cookie registration first
  //     pins the version AND avoids FST_ERR_PLUGIN_DUPLICATE.
  //   • formbody is global because /auth/logout (Plan 29-06) and HTML form
  //     posts (Plan 29-07) use application/x-www-form-urlencoded; JSON
  //     routes are unaffected (formbody only intercepts form-urlencoded).
  //
  // When OIDC is disabled (no SESSION_COOKIE_SECRET), the secure-session
  // plugin would throw on missing key — so we register cookie but SKIP
  // secure-session + formbody. The session-strategy stub at Plan 29-05
  // handles `request.session === undefined` gracefully.
  //
  // R4 dual-source-of-truth: BOTH `expiry` (server-side enforcement) AND
  // `cookie.maxAge` (browser-side Set-Cookie attribute) come from the
  // SAME constant SESSION_LIFETIME_SECONDS. A regression that updates
  // one without the other is caught by `session-plugins.test.ts`.
  await server.register(fastifyCookie);

  if (config.SESSION_COOKIE_SECRET) {
    await server.register(fastifySecureSession, {
      sessionName: 'session',
      cookieName: config.SESSION_COOKIE_NAME,
      key: Buffer.from(config.SESSION_COOKIE_SECRET, 'base64'),
      expiry: SESSION_LIFETIME_SECONDS,
      cookie: {
        path: '/',
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_LIFETIME_SECONDS,
      },
    });
    await server.register(fastifyFormbody);
  }
  // ─── end Phase 29 Plan 04 ───

  // Register public health check route (no auth required). task #185: the
  // route now returns only { status, timestamp, version } so internal stats
  // (SSE client count, uptime) are not leaked to unauthenticated probes.
  await server.register(healthRoutes, { prefix: '/health' });

  // ─── Phase 29 Plan 07 ───
  // Top-level HTML web routes: /login, /me, /me/tokens, /me/tokens/:id/revoke.
  // All carry `config.skipAuth: true` — the Phase 28 auth chain is
  // /api/v1-scoped and does not gate them. Each handler implements its
  // own session-presence check and redirects to /auth/login on miss.
  // Registered ONLY when secure-session is active (otherwise
  // request.session is undefined and the handlers cannot evaluate the
  // session gate). In OIDC-disabled mode, the routes simply don't exist.
  if (config.SESSION_COOKIE_SECRET) {
    await server.register(webRoutes);
  }
  // ─── end Phase 29 Plan 07 ───

  // ─── Phase 29 Plan 08 — top-level /auth/* routes ───
  // Conditional registration based on `app.oidcConfig`:
  //   - non-null → real authRoutes plugin (Plan 6 handlers: /auth/login,
  //     /auth/callback, /auth/logout, /auth/error). Driven by the
  //     openid-client Configuration returned from `initOidc` at boot.
  //   - null     → 501 stub at /auth/{login,callback,logout} with
  //     `{ error: 'oidc_disabled', ... }`; /auth/error stays functional
  //     because session-expiry / 403 destinations are still useful in
  //     PAT-only mode.
  //
  // Either plugin is mounted at the SAME prefix `/auth` so links from
  // Plan 7 HTML pages (e.g. /login → /auth/login) resolve regardless of
  // mode — only the response shape differs.
  if (app.oidcConfig) {
    const authRoutes = (await import('./routes/auth/index.js')).default;
    const deviceCodeRoute = (await import('./routes/auth/device-code.js'))
      .default;
    const deviceTokenRoute = (await import('./routes/auth/device-token.js'))
      .default;
    const deviceHtmlRoute = (await import('./routes/auth/device-html.js'))
      .default;
    const { effectiveOrigin } = await import('../config/env.js');
    // WR-03 fix: post_logout_redirect_uri sourced from config (immune to
    // Host-header spoofing). Smart default: derive from
    // OIDC_REDIRECT_URI's origin + `/auth/login`. The env schema's
    // all-or-nothing refine guarantees OIDC_REDIRECT_URI is set here.
    const redirectUri = config.OIDC_REDIRECT_URI as string;
    const postLogoutRedirectUri =
      config.OIDC_POST_LOGOUT_REDIRECT_URI ??
      `${new URL(redirectUri).origin}/auth/login`;
    // Plan 30-08 — device-flow routes need `origin` (verification_uri base)
    // and `clientId` (RFC 8628 `client_id` validation). effectiveOrigin
    // derives the origin from the same OIDC_REDIRECT_URI used above, so
    // the value the CLI prints matches the browser leg's host exactly.
    // OIDC_CLIENT_ID is guaranteed by the env schema's all-or-nothing
    // refine on this branch.
    const origin = effectiveOrigin(config);
    // WR-06 (Phase 30 review) — log a clear boot-time warning when the
    // effective origin fell back to localhost. In production, the Zod
    // schema's `.url()` refine on OIDC_REDIRECT_URI plus the all-or-
    // nothing OIDC refine make this unreachable when OIDC is enabled.
    // BUT the helper silently swallows `new URL(...)` failures for the
    // benefit of unit tests that pass partial env objects (see env.ts
    // §effectiveOrigin), and a future code path that bypasses Zod (or a
    // typo'd env that survives validation somehow) could land us in the
    // fallback without operators knowing. Surface the discrepancy at
    // boot so the misconfigured verification_uri that the CLI prints
    // isn't the first signal something is wrong.
    if (
      !config.OIDC_REDIRECT_URI ||
      config.OIDC_REDIRECT_URI.length === 0 ||
      origin === `http://localhost:${config.PORT}`
    ) {
      // The condition above also catches the legitimate-but-suspect
      // case where OIDC_REDIRECT_URI happens to be http://localhost:PORT
      // — in that case the warning is technically redundant but cheap,
      // and the operator gets a clear signal that the device-flow
      // verification_uri the CLI prints points at localhost.
      server.log.warn(
        {
          event: 'device_flow_origin_fallback',
          OIDC_REDIRECT_URI: config.OIDC_REDIRECT_URI ?? null,
          fallbackOrigin: origin,
        },
        'device-flow origin resolved to localhost — CLI verification_uri will be unroutable for remote clients',
      );
    }
    const clientId = config.OIDC_CLIENT_ID as string;
    await server.register(authRoutes, {
      prefix: '/auth',
      oidcConfig: app.oidcConfig,
      redirectUri,
      scopes: config.OIDC_SCOPES,
      sessionCookieName: config.SESSION_COOKIE_NAME,
      postLogoutRedirectUri,
      // Pass clientId + origin through for the device-flow surface even
      // though the barrel itself does NOT register the device routes (see
      // note in src/api/routes/auth/index.ts). The fields are part of the
      // single AuthRoutesOptions shape so OIDC-mode wiring stays a single
      // register call.
      clientId,
      origin,
    });
    // ── Plan 30-08 — device-flow routes registered DIRECTLY on the server
    //
    // The three plugin files (device-code.ts, device-token.ts,
    // device-html.ts) register their handlers at ABSOLUTE paths
    // (`/auth/device/code`, `/auth/device/token`, `/auth/device`,
    // `/auth/device/verify`) — not relative — because Plan 30-01/02/04
    // tests mount them on a bare Fastify root without a prefix. Mounting
    // them inside the auth barrel above (which sits behind `prefix:
    // '/auth'`) would double-prefix the routes to `/auth/auth/device/...`.
    // Registering at the top-level here uses the routes' absolute paths
    // verbatim, matching the CLI's expectations and the URLs printed in
    // verification_uri.
    //
    // CR-01 (Phase 30 review) — the device routes MUST run inside a scope
    // that registered the Phase 28 auth-chain plugin. The chain's
    // `decorateRequest('user', null)` and `preHandler` hook only apply to
    // routes registered INSIDE the plugin's encapsulation scope (the fp()
    // wrap lifts them one level — into THIS register lambda — but NOT into
    // arbitrary sibling top-level registrations on `server`). Without this
    // wrapping:
    //   • POST /auth/device/verify (config.sessionOnly=true) would have
    //     `request.user` === undefined, requireUser() would not throw
    //     (its guard is `=== null`), and the handler would dereference
    //     `undefined.id` → 500 in production.
    //   • The chain's `enforceSessionOnly` post-auth gate would never run,
    //     so a PAT-authed caller could in principle approve a device flow.
    // Wrapping in a register(async (scope) => ...) lambda — mirroring the
    // `/health/detailed` pattern below — gives the routes a parent scope
    // that owns the auth chain. GET /auth/device and POST
    // /auth/device/{code,token} carry `config: { skipAuth: true }` so the
    // preHandler short-circuits for them; only POST /auth/device/verify
    // exercises the session-auth path.
    await server.register(async (scope) => {
      await scope.register(authPlugin);
      await scope.register(deviceCodeRoute, {
        origin,
        expectedClientId: clientId,
      });
      await scope.register(deviceTokenRoute, { expectedClientId: clientId });
      await scope.register(deviceHtmlRoute, { origin });
    });
  } else {
    const disabledStub = (await import('./routes/auth/disabled-stub.js'))
      .default;
    const deviceDisabledStub = (
      await import('./routes/auth/device-disabled-stub.js')
    ).default;
    // Phase 29 disabled-stub covers /auth/{login,callback,logout,error};
    // Plan 30-08 device-disabled-stub covers /auth/device/{code,token,verify}
    // and GET /auth/device. Both mounted under the SAME `/auth` prefix —
    // the disabled stubs use RELATIVE paths inside their plugins so prefix
    // wiring is straightforward (unlike the enabled-mode device routes
    // which use absolute paths and are registered at the top level above).
    await server.register(disabledStub, { prefix: '/auth' });
    await server.register(deviceDisabledStub, { prefix: '/auth' });
  }
  // ─── end Phase 29 Plan 08 ───

  // task #185: authenticated detailed health check exposes the full
  // diagnostic payload (component checks + runtime stats). Gated by the
  // SAME canonical auth plugin used for /api/v1.
  await server.register(
    async (scope) => {
      await scope.register(authPlugin);
      await scope.register(detailedHealthRoutes);
    },
    { prefix: '/health/detailed' }
  );

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

      // Phase 28 Plan 28-05: per-caller resources. All routes inside
      // meRoutes carry `config: { sessionOnly: true }` so the auth-chain
      // plugin's enforceSessionOnly gate rejects PAT-authed callers with
      // 403 (PATs cannot mint/list/revoke PATs — bootstrap path is the
      // `tasks db mint-token` CLI).
      await api.register(meRoutes, { prefix: '/me' });
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
    //
    // Phase 31 (Plan 31-04): `userRepository` is now part of the Services
    // contract — registerTasksCommand uses it to look up
    // `findServiceAccountByName('slack-bot')` once at boot (cached for the
    // lifetime of the handler) and `findBySlackUserId` per-message to resolve
    // the actor. `server.log` is threaded through as the pino-style logger
    // used to emit `slack_user_unmapped` warn events.
    registerTasksCommand(
      slackApp,
      {
        taskService: app.taskService,
        projectService: app.projectService,
        dependencyService: app.dependencyService,
        commentService: app.commentService,
        userRepository: app.userRepository,
      },
      identityCache,
      subscriptionRepo,
      server.log
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

  } catch (err) {
    // task #257: registration failed (most often
    // `validateApiKeysForProduction` rejecting weak prod keys). Drain the
    // onClose hooks so we don't leak EventBus subscriptions, the SSE manager
    // heartbeat, idempotency interval, claim-release timer, etc. Also dispose
    // the underlying App (closes the DB handle and re-stops the workflow
    // engine — both calls are idempotent).
    try {
      await server.close();
    } catch {
      // Swallow secondary errors so the original cause propagates.
    }
    try {
      app.dispose();
    } catch {
      // Same — protect the throw of the original error.
    }
    throw err;
  }
}
