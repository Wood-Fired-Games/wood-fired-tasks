import Fastify, { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import type Database from '../db/driver.js';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import fastifySSE, { SSEPluginOptions } from '@fastify/sse';
import fastifyHelmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import fastifyFormbody from '@fastify/formbody';
import { createApp, App, type OidcStatus } from '../index.js';
import { config } from '../config/env.js';
import { SESSION_LIFETIME_SECONDS } from '../web/session-constants.js';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { DependencyService } from '../services/dependency.service.js';
import { DependencyGraphService } from '../services/dependency-graph.service.js';
import { TopologyService } from '../services/topology.service.js';
import { CommentService } from '../services/comment.service.js';
import { SettingsService } from '../services/settings.service.js';
import { ModelCatalogService } from '../services/model-catalog.service.js';
import type { ModelPolicyService } from '../services/model-policy.service.js';
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
import modelsRoutes from './routes/models/index.js';
import modelPolicyRoutes from './routes/settings/model-policy.js';
import auditRoutes from './routes/audit/index.js';
import meRoutes from './routes/me/index.js';
import webRoutes from './routes/web/index.js';
import healthRoutes, { detailedHealthRoutes } from './routes/health.js';
import { errorHandler } from './hooks/error-handler.js';
import auditTrailPlugin from './hooks/audit-trail.js';
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
    topologyService: TopologyService;
    commentService: CommentService;
    /** Configurable Task Models (Task 13): backs GET|PUT /settings/model-policy. */
    settingsService: SettingsService;
    /** Configurable Task Models (Task 13): backs GET /models. */
    modelCatalogService: ModelCatalogService;
    /** Configurable Task Models (Task #926): backs GET /projects/:id/resolve-model. */
    modelPolicyService: ModelPolicyService;
    idempotencyService: IdempotencyService;
    db: Database.Database;
    sseManager: SSEManager;
    /** Task #357: OIDC subsystem state for the /health/detailed signal. */
    oidcStatus: OidcStatus;
  }
}

/**
 * Rate-limit bucket key for a request. Prefers the authenticated principal
 * (PAT token id, else user id) so a single proxy IP does not collapse every
 * authenticated client into one bucket; falls back to `request.ip`, which
 * Fastify resolves from X-Forwarded-For ONLY when `trustProxy` is set
 * (default OFF — see `createServer`'s Fastify options for the spoof-
 * resistance guarantee).
 *
 * Audit H2 (2026-07-26) — exported (rather than left as an inline closure)
 * so `rate-limit.test.ts` can assert directly on the generated key shape
 * without needing an end-to-end HTTP round trip. This ONLY reads decorated
 * request state; it does not perform its own auth — it depends on the
 * PRINCIPAL-KEYED rate-limit layer being registered with `hook: 'preHandler'`
 * (see below) so the auth chain's `preHandler` has already run and populated
 * `tokenId`/`user` by the time this executes.
 *
 * This is layer 2 of the two-tier design below; it does NOT replace the
 * layer 1 IP-keyed, pre-auth limiter — see the comment on `createServer`'s
 * rate-limit registrations for why both layers are required.
 */
export function rateLimitKeyGenerator(req: {
  tokenId?: number | null;
  user?: { id: number } | null;
  ip: string;
}): string {
  const tokenId = req.tokenId;
  if (typeof tokenId === 'number') return `tok:${tokenId}`;
  const user = req.user;
  if (user && typeof user.id === 'number') return `usr:${user.id}`;
  return `ip:${req.ip}`;
}

/**
 * Multiplier applied to `config.RATE_LIMIT_MAX` to derive the budget for the
 * coarse, pre-auth, IP-keyed rate-limit layer (layer 1 below).
 *
 * Audit H2 review (2026-07-26) — the first cut of the H2 fix moved the ONLY
 * rate-limit registration to `hook: 'preHandler'` so its keyGenerator could
 * read the authenticated principal. That broke a real security property:
 * the auth chain's preHandler sends its 401 and short-circuits the hook
 * chain, so a request with NO or INVALID credentials never reaches a
 * `preHandler`-phase limiter at all — brute-force credential guessing
 * against an auth-gated route became completely unthrottled.
 *
 * The fix is TWO independent layers (see `createServer`), not one:
 *   - Layer 1 (`onRequest`, IP-keyed): unconditionally runs before auth, so
 *     it catches unauthenticated/invalid-credential floods regardless of
 *     whether auth ultimately accepts or rejects the request.
 *   - Layer 2 (`preHandler`, principal-keyed via `rateLimitKeyGenerator`):
 *     the actual H2 fix — isolates each authenticated principal's budget
 *     from a shared proxy IP.
 *
 * Layer 1's budget MUST be comfortably larger than layer 2's, or it
 * re-introduces the H2 collapse for well-behaved traffic: EVERY request
 * from an IP (successful or not) consumes layer 1's budget, so if it were
 * sized the same as (or smaller than) the per-principal budget, many
 * distinct legitimate authenticated clients sharing one reverse-proxy IP
 * would trip the coarse layer well before any single principal exhausts
 * its own fair share. A multiplier (rather than a fixed constant) keeps
 * that headroom proportional however an operator tunes RATE_LIMIT_MAX.
 * Exported so tests can compute the exact trip point instead of
 * hard-coding a magic number.
 */
export const RATE_LIMIT_IP_MAX_FACTOR = 20;

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
    // Issue #75 — proxy-aware client identity. `trustProxy` makes
    // `request.ip` resolve from `X-Forwarded-For` (consistent with the
    // device-flow origin trust in §3a). DEFAULT OFF (config.TRUST_PROXY ===
    // false) so a spoofed X-Forwarded-For cannot move a client's rate-limit
    // bucket on the loopback-bind default; operators behind a reverse proxy
    // opt in via TRUST_PROXY. Accepts boolean | number (hop count) | string[]
    // (IP/CIDR allowlist) — see src/config/env.ts.
    trustProxy: config.TRUST_PROXY,
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
      // exactOptionalPropertyTypes: `transport?` is exact-optional in pino's
      // LoggerOptions, so an explicit `transport: undefined` no longer satisfies
      // it (and forces TS onto the trailing Http2 `Fastify` overload, which then
      // cascades the FastifyInstance generic-variance errors below). Spread the
      // key in only for development so it is genuinely ABSENT otherwise.
      ...(config.NODE_ENV === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true },
        },
      }),
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
  server.decorate('topologyService', app.topologyService);
  server.decorate('commentService', app.commentService);
  // Configurable Task Models (Task 13): the settings + model-catalog services
  // back the /settings/model-policy and /models routes respectively.
  server.decorate('settingsService', app.settingsService);
  server.decorate('modelCatalogService', app.modelCatalogService);
  // Configurable Task Models (Task #926 / #931): the model-policy resolver
  // behind GET /projects/:id/resolve-model. Constructed ONCE in `createApp`
  // (same instance the stdio MCP server wires behind its `resolve_model`
  // tool) — see src/index.ts for the dep wiring.
  server.decorate('modelPolicyService', app.modelPolicyService);
  server.decorate('db', app.db);
  // Task #357: expose OIDC boot state to /health/detailed so a degraded
  // discovery is a queryable signal, not just a one-time boot log line.
  // Explicit generic: `decorate` otherwise infers the value type from the
  // runtime object and narrows the OidcStatus union to a single variant.
  server.decorate<OidcStatus>('oidcStatus', app.oidcStatus);

  // Phase 28 (Plan 28-04): identity repositories decorated for the auth
  // chain plugin's per-request PAT lookups (`findByHash`) and legacy
  // principal resolution (`findLegacyByDisplayName`). The matching
  // FastifyInstance augmentation is centralized in `src/types/fastify.d.ts`
  // — DO NOT add them to the local `declare module 'fastify'` block above;
  // TypeScript merges all `interface FastifyInstance` declarations across
  // files and a duplicate here would conflict.
  server.decorate('userRepository', app.userRepository);
  server.decorate('apiTokenRepository', app.apiTokenRepository);

  // Security Audit finding M5 (task #1630): the append-only `audit_events`
  // writer consumed by the response-phase audit hook registered inside the
  // `/api/v1` scope below. Decorated (rather than closed over) so the hook
  // resolves it per request — that is what lets a test stub `append` and
  // prove an audit failure cannot change the client's HTTP status. Its
  // FastifyInstance augmentation lives with the hook, in
  // `src/api/hooks/audit-trail.ts`.
  server.decorate('auditEventRepository', app.auditEventRepository);

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
    config.SSE_MAX_CONNECTIONS,
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
    eventBus.subscribe('task.claim_released', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('project.created', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('project.updated', (event) => sseManager.broadcast(event)),
    eventBus.subscribe('project.deleted', (event) => sseManager.broadcast(event)),
  ];

  // Create and start ClaimReleaseService for auto-releasing stale claims
  const claimReleaseService = new ClaimReleaseService(app.db);
  claimReleaseService.start(); // Sweep every 5 minutes by default

  // Start periodic idempotency key cleanup (every hour)
  const idempotencyCleanupInterval = setInterval(
    () => {
      idempotencyService.cleanup();
    },
    60 * 60 * 1000,
  );

  // Create SlackService (no-op if Slack tokens absent)
  const slackService = new SlackService(config.SLACK_BOT_TOKEN, config.SLACK_APP_TOKEN, server.log);

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

    // Task #383: register @fastify/helmet ONCE at the top level so the JSON
    // API surface (and every other response) carries the standard security
    // headers — most importantly `x-content-type-options: nosniff`, plus
    // `x-frame-options` and HSTS (`strict-transport-security`).
    //
    // contentSecurityPolicy is DISABLED here on purpose: the server-rendered
    // HTML surface (web routes, /auth/error) manages its OWN Content-Security-
    // Policy / X-Frame-Options / Referrer-Policy via a scoped onSend hook
    // (see src/api/routes/web/index.ts and HTML_SECURITY_HEADERS in
    // src/web/html.js, audit C5). Letting helmet emit a global default-src
    // 'none' CSP would either fight those routes' inline-style/script needs or
    // produce duplicate/conflicting CSP headers. Leaving CSP to the HTML
    // routes keeps a single source of truth for the framed surfaces while
    // helmet still hardens the JSON API (which cannot be framed and needs no
    // CSP). All other helmet defaults — including X-Content-Type-Options,
    // X-Frame-Options, and Strict-Transport-Security — remain enabled.
    await server.register(fastifyHelmet, {
      contentSecurityPolicy: false,
    });

    // Security Audit finding M1 (task #1622) — build-time route-scope audit.
    // Collects a { method, url, config } triple for every route registered
    // inside an authenticated scope (the production-posture Swagger UI scope
    // below, the `/health/detailed` scope, and the `/api/v1` scope), so the
    // drift-guard test (src/api/__tests__/route-scope-coverage.test.ts) can
    // enumerate the ACTUAL built route table instead of a hand-maintained file
    // list — the exact blindness the AC exists to prevent. `onRoute` hooks
    // registered on a scope observe every route added to that scope AND its
    // descendants (nested child plugins — dependency-graph, wsjf, tokens, the
    // swagger-ui plugin's own routes, etc. — are captured too), so registering
    // the hook as the FIRST statement inside each scope callback below is
    // sufficient; no per-route-file wiring is needed. Attached to `server` via
    // a plain cast (not a typed Fastify decorator) to keep this addition
    // self-contained to this region — no fastify.d.ts module augmentation
    // required.
    //
    // Defined HERE — above the Swagger UI registration rather than next to the
    // `/api/v1` scope it also serves — because the production-posture Swagger
    // scope is registered first and needs the same collector; a collector
    // declared later would not be in scope for it, and the swagger routes would
    // silently stay invisible to the drift guard (the original M1 hole).
    type RouteAuditEntry = { method: string; url: string; config: Record<string, unknown> };
    const authenticatedRouteAudit: RouteAuditEntry[] = [];
    (server as unknown as { authenticatedRouteAudit: RouteAuditEntry[] }).authenticatedRouteAudit =
      authenticatedRouteAudit;
    const collectRouteAudit = (routeOptions: {
      method: string | string[];
      url: string;
      config?: Record<string, unknown>;
    }): void => {
      authenticatedRouteAudit.push({
        method: Array.isArray(routeOptions.method)
          ? routeOptions.method.join(',')
          : routeOptions.method,
        url: routeOptions.url,
        config: routeOptions.config ?? {},
      });
    };

    // Register Swagger/OpenAPI spec collector (must be before routes so it can
    // capture their schemas). task #185: the spec collector itself does not
    // expose any HTTP endpoint — only `@fastify/swagger-ui` does that, and we
    // register it conditionally below.
    await registerSwaggerSpec(server);

    // task #1612 (H1/H3 audit finding): gate Swagger UI / `/docs/json` behind
    // an EXPLICIT opt-in in EVERY environment, not only production.
    //
    // `@fastify/swagger-ui` transitively registers `@fastify/static`, which
    // carries an unfixed HIGH advisory — so this isn't only about hiding
    // `/docs` from unauthenticated callers, it's about never LOADING the
    // vulnerable plugin in a hardened posture at all. Gating on
    // `config.NODE_ENV !== 'production'` (the pre-#1612 behavior) meant an
    // absent NODE_ENV — the common containerized "operator forgot to set it"
    // case — silently fell into the permissive non-production branch and
    // loaded `@fastify/static` unauthenticated. That is exactly the bug #1611
    // introduced `isProductionPosture` to close: absence must read as
    // "hardened", not "permissive".
    //
    // - Opt-in unset (default), ANY environment: do NOT register the UI
    //   plugin (or its transitive `@fastify/static`) at all. `/docs` and
    //   `/docs/json` return 404.
    // - Opt-in set + isProductionPosture (explicit 'production', OR NODE_ENV
    //   absent/unset): expose UI but require a valid credential (same
    //   canonical auth plugin used for /api/v1).
    // - Opt-in set + explicit NODE_ENV=development|test (isProductionPosture
    //   false): expose UI without auth — unchanged dev ergonomics, now
    //   requires the same explicit opt-in as every other environment.
    //
    // task #1617 completes the H3 remediation: `@fastify/swagger-ui` is now a
    // devDependency and `registerSwaggerUI` imports it dynamically, so the
    // vulnerable `@fastify/static` is absent from the production dependency
    // tree entirely (not merely unregistered). Because the default path below
    // never calls `registerSwaggerUI`, the dynamic import is never evaluated
    // and a missing module cannot affect boot. When the opt-in IS set and the
    // module is absent, `registerSwaggerUI` logs a warning and returns false
    // rather than throwing, so `/docs` degrades to 404 instead of bricking the
    // server. (The warning is emitted inside `registerSwaggerUI` against the
    // encapsulated instance — deliberately not re-checked here, because the
    // production-posture branch registers through a deferred plugin callback
    // whose return value is not observable at this point in the boot queue.)
    const exposeSwaggerUI = config.ENABLE_SWAGGER_IN_PRODUCTION === true;
    if (exposeSwaggerUI) {
      if (config.isProductionPosture) {
        await server.register(async (scope) => {
          // Security Audit finding M1 (task #1622) — the swagger-ui plugin
          // registers its own routes (`/docs`, `/docs/json`, `/docs/static/*`,
          // …) INSIDE this authenticated scope, but they are third-party
          // registrations: we cannot add a `config.requiredScope` at their
          // definition sites the way every first-party route file does. Left
          // alone they would be authenticated-but-UNDECLARED, and
          // `enforceRequiredScope` (src/api/plugins/auth/index.ts) fails OPEN
          // on an undeclared route — any successfully-authenticated principal,
          // whatever its scope grant, could read them. This `onRoute` hook
          // closes that by stamping the declaration on the way in and feeding
          // the SAME `collectRouteAudit` collector the other authenticated
          // scopes use, so the drift guard can actually see them.
          //
          // `read` is the correct tier: viewing API docs is a read operation,
          // and `read` is the lowest tier in the PAT_SCOPES taxonomy — every
          // non-empty grant satisfies it (see `grantSatisfiesScope`), so this
          // adds no functional restriction beyond "must be authenticated",
          // which this scope already imposes. It is a DECLARATION, not an
          // exemption: marking these routes `skipAuth`/`sessionOnly` would
          // quiet the guard while leaving the fail-open hole intact.
          //
          // Mutating `routeOptions.config` from an `onRoute` hook is the
          // supported way to do this: Fastify runs the onRoute hooks BEFORE it
          // derives the route context's `config` from `opts.config`
          // (fastify/lib/route.js — hooks at the top of `addNewRoute`, the
          // `{ ...opts.config, url, method }` spread further down), so the
          // stamp is what `request.routeOptions.config` reports at request
          // time. The `undefined` guard keeps any future route that declares
          // its own tier authoritative.
          scope.addHook('onRoute', (routeOptions) => {
            const mutable = routeOptions as unknown as {
              method: string | string[];
              url: string;
              config?: Record<string, unknown>;
            };
            const routeConfig = mutable.config ?? {};
            if (
              routeConfig['requiredScope'] === undefined &&
              routeConfig['skipAuth'] !== true &&
              routeConfig['sessionOnly'] !== true
            ) {
              routeConfig['requiredScope'] = 'read';
            }
            mutable.config = routeConfig;
            collectRouteAudit(mutable);
          });
          await scope.register(authPlugin);
          await registerSwaggerUI(scope);
        });
      } else {
        await registerSwaggerUI(server);
      }
    }

    // Register @fastify/sse plugin (must be before routes that use SSE)
    await server.register(
      fastifySSE as any,
      {
        heartbeatInterval: 30000,
      } as SSEPluginOptions,
    );

    // Register global rate limiting (task #182: defense against brute-force
    // and high-volume abuse). /health is allow-listed so liveness/readiness
    // probes never consume the budget. Defaults are intentionally high to
    // avoid disrupting the existing test suite, which exercises many
    // server.inject calls from 127.0.0.1; operators tune via env.
    //
    // Audit H2 (2026-07-26) — TWO independent layers, registered back to
    // back, so both properties hold at once (see `RATE_LIMIT_IP_MAX_FACTOR`
    // above for the full history/rationale):
    //
    //   1. IP-KEYED, `onRequest` (coarse, pre-auth): preserves brute-force
    //      defence — `onRequest` unconditionally completes before the auth
    //      chain's `preHandler` can reject (and short-circuit) a request, so
    //      repeated invalid-credential/unauthenticated traffic from one
    //      source IP is still throttled regardless of auth outcome.
    //   2. PRINCIPAL-KEYED, `preHandler` (fine-grained, post-auth): the
    //      actual H2 fix — `rateLimitKeyGenerator` reads the decorated
    //      `tokenId`/`user` so each authenticated principal gets an
    //      independent budget instead of collapsing into the shared proxy
    //      IP bucket.
    //
    // @fastify/rate-limit supports being registered more than once on the
    // same instance: each registration adds its OWN `onRoute` listener with
    // its own store/closure, and each listener injects its handler into a
    // DIFFERENT per-route hook array (`routeOptions.onRequest` vs
    // `routeOptions.preHandler`) — see @fastify/rate-limit/index.js
    // `addRouteRateHook`. No collisions: the internal `rateLimitRan`
    // decorator is a fresh `Symbol()` per registration, and the
    // `rateLimit`/`createRateLimit` instance decorators are guarded by
    // `hasDecorator` so the second registration's redundant decorate calls
    // are harmless no-ops.
    const rateLimitAllowList = (req: { url: string }) =>
      req.url === '/health' || req.url.startsWith('/health/');
    // The error returned here is thrown by @fastify/rate-limit; the project's
    // custom errorHandler reads `statusCode` and `code` to shape the JSON
    // response. Shared by BOTH layers so { error: 'TOO_MANY_REQUESTS', ... }
    // is identical regardless of which layer throttled the request.
    const rateLimitErrorResponseBuilder = (
      _req: unknown,
      ctx: { statusCode: number; after: string },
    ) => {
      const err = new Error(`Rate limit exceeded, retry in ${ctx.after}`) as Error & {
        statusCode?: number;
        code?: string;
      };
      err.statusCode = ctx.statusCode;
      err.code = 'TOO_MANY_REQUESTS';
      return err;
    };

    // Layer 1 — coarse, IP-keyed, pre-auth flood/brute-force defence.
    // `keyGenerator` is omitted: @fastify/rate-limit's own default
    // (`(req) => req.ip`) is exactly what this layer wants, and staying
    // unauthenticated-only here keeps it trivially independent of the auth
    // chain (it must run correctly even when auth never gets to execute).
    await server.register(rateLimit, {
      max: config.RATE_LIMIT_MAX * RATE_LIMIT_IP_MAX_FACTOR,
      timeWindow: config.RATE_LIMIT_TIME_WINDOW,
      allowList: rateLimitAllowList,
      hook: 'onRequest',
      errorResponseBuilder: rateLimitErrorResponseBuilder,
    });

    // Layer 2 — fine-grained, principal-keyed (Issue #75 / Audit H2 fix).
    // @fastify/rate-limit does NOT add a plain instance-level hook; it
    // registers an `onRoute` listener that injects its per-request handler
    // into THAT route's own `routeOptions[hook]` array. Route-level hook
    // arrays run AFTER the scope's instance-level hooks (e.g. the auth
    // chain's `preHandler` registered inside the `/api/v1`, `/health/
    // detailed`, and production-swagger scopes) for the SAME phase — so
    // pinning `hook: 'preHandler'` here is sufficient to guarantee the auth
    // chain has already decorated `request.tokenId` / `request.user` by the
    // time `rateLimitKeyGenerator` runs, with NO registration-order change
    // required relative to those auth scopes.
    await server.register(rateLimit, {
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_TIME_WINDOW,
      allowList: rateLimitAllowList,
      hook: 'preHandler',
      keyGenerator: rateLimitKeyGenerator,
      errorResponseBuilder: rateLimitErrorResponseBuilder,
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
          // task #1613 (H1 audit finding): derive from the fail-closed
          // posture flag (task #1611), not raw NODE_ENV — an absent
          // NODE_ENV must read as hardened, not permissive. Same idiom as
          // the Swagger UI gate (task #1612, commit d0cc487).
          secure: config.isProductionPosture,
          sameSite: 'lax',
          maxAge: SESSION_LIFETIME_SECONDS,
        },
      });
      await server.register(fastifyFormbody);
    }
    // ─── end Phase 29 Plan 04 ───

    // ─── Security Audit finding M5 (task #1630) — REST audit-trail producer ───
    //
    // Registered on the ROOT instance, ABOVE every route registration below,
    // rather than inside the `/api/v1` scope.
    //
    // Why root and not per-scope: the acceptance criterion is "one row per
    // AUTHENTICATED non-GET request", unqualified — not "per /api/v1 request".
    // The authenticated surface is spread across four sibling scopes (the
    // production-posture Swagger scope, the device-flow scope, the
    // `/health/detailed` scope, the `/api/v1` scope) PLUS top-level web HTML
    // routes that carry `config.skipAuth` and run their own session gate
    // (`POST /me/tokens/:id/revoke`). Registering the plugin once per
    // authenticated scope would have covered the scopes that exist TODAY and
    // silently missed the next one somebody adds — the same class of blindness
    // finding M1 was about. A single root registration is scope-agnostic: a
    // hook on the root instance runs for every routed request in every
    // descendant scope, so a new authenticated scope is audited the moment it
    // is created, with no wiring to remember.
    //
    // Why exactly one row is structurally guaranteed: this is the ONLY
    // registration of `auditTrailPlugin` in the process, and Fastify runs an
    // instance-level `onResponse` hook exactly once per request regardless of
    // how deeply the matched route's scope is nested. There is no nesting
    // arrangement that can double-count, because there is no second hook.
    // (Registering it in both a parent and a child scope WOULD double-count —
    // see the no-duplication test in audit-trail.test.ts.)
    //
    // Requests with no principal write nothing: the hook reads `request.user`,
    // which is `undefined` outside any auth-bearing scope and `null` on the
    // 401 path, and `audit_events.actor_id` is NOT NULL by design.
    await server.register(auditTrailPlugin);

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
      const deviceCodeRoute = (await import('./routes/auth/device-code.js')).default;
      const deviceTokenRoute = (await import('./routes/auth/device-token.js')).default;
      const deviceHtmlRoute = (await import('./routes/auth/device-html.js')).default;
      const { effectiveOrigin } = await import('../config/env.js');
      // WR-03 fix: post_logout_redirect_uri sourced from config (immune to
      // Host-header spoofing). Smart default: derive from
      // OIDC_REDIRECT_URI's origin + `/auth/login`. The env schema's
      // all-or-nothing refine guarantees OIDC_REDIRECT_URI is set here.
      const redirectUri = config.OIDC_REDIRECT_URI as string;
      const postLogoutRedirectUri =
        config.OIDC_POST_LOGOUT_REDIRECT_URI ?? `${new URL(redirectUri).origin}/auth/login`;
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
      // #833: the device-flow `client_id` is a SEPARATE logical identifier the
      // CLI sends (default `'wft-cli'`), NOT the IdP's OAuth client id. Using
      // OIDC_CLIENT_ID here rejected the stock CLI with `invalid_client` on any
      // real-IdP server. Always defaulted, so device flow works out of the box.
      const deviceClientId = config.OIDC_DEVICE_CLIENT_ID;
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
          expectedClientId: deviceClientId,
          // Issue #68 (finding 2) — optional operator allowlist pinning which
          // hostnames the per-request verification origin may be derived from.
          trustedHosts: config.DEVICE_FLOW_TRUSTED_HOSTS,
        });
        await scope.register(deviceTokenRoute, { expectedClientId: deviceClientId });
        await scope.register(deviceHtmlRoute, { origin });
      });
    } else {
      const disabledStub = (await import('./routes/auth/disabled-stub.js')).default;
      const deviceDisabledStub = (await import('./routes/auth/device-disabled-stub.js')).default;
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
        scope.addHook('onRoute', collectRouteAudit);
        await scope.register(authPlugin);
        await scope.register(detailedHealthRoutes);
      },
      { prefix: '/health/detailed' },
    );

    // Register routes under /api/v1 with auth protection
    await server.register(
      async (api) => {
        api.addHook('onRoute', collectRouteAudit);
        // Centralized auth (task #182): single canonical plugin. Hardens
        // production keys, uses constant-time comparison, logs invalid
        // attempts without leaking the supplied key.
        await api.register(authPlugin);

        // NOTE (task #1630): the audit-trail producer is deliberately NOT
        // registered here. It is registered ONCE on the root instance above
        // (search "finding M5"), which covers this scope and every other
        // authenticated scope at the same time. Adding a second registration
        // here would append TWO rows for every /api/v1 mutation.
        //
        // Ordering is a non-issue: `onResponse` is a strictly later phase than
        // the auth chain's `preHandler`, so the hook always observes the
        // principal the chain resolved — including on a request the chain
        // itself short-circuited with a 403, which is precisely why
        // scope-denied mutations get recorded instead of silently dropped.

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

        // Configurable Task Models (Task 13): the model catalog + the
        // database-wide model-policy default.
        await api.register(modelsRoutes, { prefix: '/models' });
        await api.register(modelPolicyRoutes, { prefix: '/settings' });

        // Security Audit finding M5 (task #1637): READ-ONLY query surface over
        // the append-only audit trail. GET only — see the module docblock in
        // routes/audit/index.ts for why no write verb exists here, and
        // `project-binding.ts` for why bound tokens are denied it outright.
        await api.register(auditRoutes, { prefix: '/audit-events' });

        // Phase 28 Plan 28-05: per-caller resources. All routes inside
        // meRoutes carry `config: { sessionOnly: true }` so the auth-chain
        // plugin's enforceSessionOnly gate rejects PAT-authed callers with
        // 403 (PATs cannot mint/list/revoke PATs — bootstrap path is the
        // `tasks db mint-token` CLI).
        await api.register(meRoutes, { prefix: '/me' });
      },
      { prefix: '/api/v1' },
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
        server.log,
      );

      // Create and start notification pipeline
      const slackNotifier = new SlackNotifier(
        slackApp.client,
        subscriptionRepo,
        app.projectService,
        server.log,
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
