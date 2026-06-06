import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eventBus } from '../../events/event-bus.js';
import { VERSION } from '../../utils/version.js';

/**
 * Public, unauthenticated health check.
 *
 * task #185: the response is intentionally minimal — only `{ status, timestamp,
 * version }`. Component checks and runtime statistics (SSE client count,
 * uptime, event-bus listener counts) used to be leaked here, which gave any
 * unauthenticated probe a fingerprint of the deployment. Those details have
 * moved to `/health/detailed` behind X-API-Key auth.
 *
 * The handler still pings the database so liveness probes (k8s, load
 * balancers, GitHub Actions step gates) can distinguish a hung process from
 * a DB-outage process — it returns 503 in the same minimal shape on failure.
 */
const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['health'],
        description: 'Minimal public health check (status + timestamp + version)',
        response: {
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
          }),
          503: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const timestamp = new Date().toISOString();
      const version = VERSION;

      // Check database connectivity (the only critical check on the
      // public endpoint — if it fails, return 503 in the minimal shape).
      let databaseStatus: 'ok' | 'failed' = 'ok';
      try {
        fastify.db.prepare('SELECT 1').get();
      } catch (err) {
        request.log.error(err, 'Database health check failed');
        databaseStatus = 'failed';
      }

      if (databaseStatus === 'failed') {
        return reply.code(503).send({
          status: 'unhealthy',
          timestamp,
          version,
        });
      }

      return {
        status: 'healthy',
        timestamp,
        version,
      };
    },
  );
};

/**
 * Detailed diagnostic health check (component checks + runtime stats).
 *
 * task #185: this is the route previously served at `/health`. It is now
 * registered inside an auth-protected scope at `/health/detailed` so the
 * SSE client count, uptime, and per-component status are not exposed to
 * unauthenticated callers. Same response shape as the pre-task-#185
 * `/health` so existing ops dashboards can switch the URL without payload
 * changes.
 */
export const detailedHealthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['health'],
        description: 'Detailed authenticated health check with component status and runtime stats',
        response: {
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
            database: z.object({
              path: z.string(),
              projects: z.number(),
              maxTaskId: z.number().nullable(),
              latestActivity: z.string().nullable(),
            }),
            checks: z.object({
              database: z.enum(['ok', 'failed']),
              eventBus: z.enum(['ok', 'degraded', 'unknown']),
              sseManager: z.enum(['ok', 'degraded', 'unknown']),
              // Task #357: OIDC subsystem state. `degraded` = configured but
              // boot discovery failed after all retries — login is down while
              // PAT/legacy auth keeps working.
              oidc: z.enum(['disabled', 'ready', 'degraded']),
            }),
            // Task #357: OIDC discovery detail — issuer, retry attempts, and
            // the last error when degraded — so this endpoint explains WHY,
            // not just THAT, OIDC login is unavailable.
            oidc: z.object({
              state: z.enum(['disabled', 'ready', 'degraded']),
              issuer: z.string().optional(),
              attempts: z.number().optional(),
              error: z.string().optional(),
            }),
            stats: z
              .object({
                eventBus: z.object({ listenerCount: z.number() }),
                sseManager: z.object({ clientCount: z.number(), uptime: z.number() }),
              })
              .optional(),
          }),
          503: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
            database: z.object({
              path: z.string(),
              projects: z.number(),
              maxTaskId: z.number().nullable(),
              latestActivity: z.string().nullable(),
            }),
            checks: z.object({
              database: z.enum(['ok', 'failed']),
              eventBus: z.enum(['ok', 'degraded', 'unknown']),
              sseManager: z.enum(['ok', 'degraded', 'unknown']),
              // Task #357: OIDC subsystem state. `degraded` = configured but
              // boot discovery failed after all retries — login is down while
              // PAT/legacy auth keeps working.
              oidc: z.enum(['disabled', 'ready', 'degraded']),
            }),
            // Task #357: OIDC discovery detail — issuer, retry attempts, and
            // the last error when degraded — so this endpoint explains WHY,
            // not just THAT, OIDC login is unavailable.
            oidc: z.object({
              state: z.enum(['disabled', 'ready', 'degraded']),
              issuer: z.string().optional(),
              attempts: z.number().optional(),
              error: z.string().optional(),
            }),
            stats: z
              .object({
                eventBus: z.object({ listenerCount: z.number() }),
                sseManager: z.object({ clientCount: z.number(), uptime: z.number() }),
              })
              .optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const timestamp = new Date().toISOString();
      const version = VERSION;

      // Check database connectivity and capture a fingerprint so an operator
      // can confirm WHICH database this process opened (resolved path + cheap
      // counts) — the signal that was missing during the 2026-05-25 incident.
      let databaseStatus: 'ok' | 'failed' = 'ok';
      let database: {
        path: string;
        projects: number;
        maxTaskId: number | null;
        latestActivity: string | null;
      } = {
        path: fastify.db.name,
        projects: 0,
        maxTaskId: null,
        latestActivity: null,
      };
      try {
        fastify.db.prepare('SELECT 1').get();
        const projectRow = fastify.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as {
          n: number;
        };
        const maxIdRow = fastify.db.prepare('SELECT MAX(id) AS m FROM tasks').get() as {
          m: number | null;
        };
        const latestRow = fastify.db.prepare('SELECT MAX(updated_at) AS t FROM tasks').get() as {
          t: string | null;
        };
        database = {
          path: fastify.db.name,
          projects: projectRow.n,
          maxTaskId: maxIdRow.m ?? null,
          latestActivity: latestRow.t ?? null,
        };
      } catch (err) {
        request.log.error(err, 'Database health check failed');
        databaseStatus = 'failed';
      }

      // Check event bus status
      const eventBusStatus: 'ok' | 'degraded' | 'unknown' = eventBus.isActive() ? 'ok' : 'degraded';
      const eventBusStats = eventBus.getStats();

      // Check SSE manager status
      const sseManagerStatus: 'ok' | 'degraded' | 'unknown' = fastify.sseManager.isHealthy()
        ? 'ok'
        : 'degraded';
      const sseManagerStats = fastify.sseManager.getStats();

      // Task #357: OIDC boot state. `state` is the same discriminated union
      // captured in createApp; spreading it yields exactly the optional
      // issuer/attempts/error fields the schema allows. `checks.oidc` mirrors
      // `state` so existing check-scanning dashboards pick it up automatically.
      const oidc = { ...fastify.oidcStatus };

      // Database is the critical check - return 503 if it fails
      if (databaseStatus === 'failed') {
        return reply.code(503).send({
          status: 'unhealthy',
          timestamp,
          version,
          database,
          checks: {
            database: databaseStatus,
            eventBus: eventBusStatus,
            sseManager: sseManagerStatus,
            oidc: oidc.state,
          },
          oidc,
          stats: {
            eventBus: eventBusStats,
            sseManager: sseManagerStats,
          },
        });
      }

      // Return healthy response with component status
      return {
        status: 'healthy',
        timestamp,
        version,
        database,
        checks: {
          database: databaseStatus,
          eventBus: eventBusStatus,
          sseManager: sseManagerStatus,
          oidc: oidc.state,
        },
        oidc,
        stats: {
          eventBus: eventBusStats,
          sseManager: sseManagerStats,
        },
      };
    },
  );
};

export default healthRoutes;
