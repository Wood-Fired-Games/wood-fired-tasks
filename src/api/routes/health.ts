import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eventBus } from '../../events/event-bus.js';

/**
 * Health check endpoint - publicly accessible without authentication
 */
const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['health'],
        description: 'Service health check with component status',
        response: {
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
            checks: z.object({
              database: z.enum(['ok', 'failed']),
              eventBus: z.enum(['ok', 'degraded', 'unknown']),
              sseManager: z.enum(['ok', 'degraded', 'unknown']),
            }),
            stats: z.object({
              eventBus: z.object({ listenerCount: z.number() }),
              sseManager: z.object({ clientCount: z.number(), uptime: z.number() }),
            }).optional(),
          }),
          503: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
            checks: z.object({
              database: z.enum(['ok', 'failed']),
              eventBus: z.enum(['ok', 'degraded', 'unknown']),
              sseManager: z.enum(['ok', 'degraded', 'unknown']),
            }),
            stats: z.object({
              eventBus: z.object({ listenerCount: z.number() }),
              sseManager: z.object({ clientCount: z.number(), uptime: z.number() }),
            }).optional(),
          }),
        },
      },
    },
    async (request, reply) => {
      const timestamp = new Date().toISOString();
      const version = '1.0.0';

      // Check database connectivity
      let databaseStatus: 'ok' | 'failed' = 'ok';
      try {
        fastify.db.prepare('SELECT 1').get();
      } catch (err) {
        request.log.error(err, 'Database health check failed');
        databaseStatus = 'failed';
      }

      // Check event bus status
      const eventBusStatus: 'ok' | 'degraded' | 'unknown' = eventBus.isActive() ? 'ok' : 'degraded';
      const eventBusStats = eventBus.getStats();

      // Check SSE manager status
      const sseManagerStatus: 'ok' | 'degraded' | 'unknown' = fastify.sseManager.isHealthy() ? 'ok' : 'degraded';
      const sseManagerStats = fastify.sseManager.getStats();

      // Database is the critical check - return 503 if it fails
      if (databaseStatus === 'failed') {
        return reply.code(503).send({
          status: 'unhealthy',
          timestamp,
          version,
          checks: {
            database: databaseStatus,
            eventBus: eventBusStatus,
            sseManager: sseManagerStatus,
          },
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
        checks: {
          database: databaseStatus,
          eventBus: eventBusStatus,
          sseManager: sseManagerStatus,
        },
        stats: {
          eventBus: eventBusStats,
          sseManager: sseManagerStats,
        },
      };
    }
  );
};

export default healthRoutes;
