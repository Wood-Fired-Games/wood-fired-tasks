import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Health check endpoint - publicly accessible without authentication
 */
const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['health'],
        description: 'Service health check',
        response: {
          200: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
            checks: z.object({
              database: z.string(),
            }),
          }),
          503: z.object({
            status: z.string(),
            timestamp: z.string(),
            version: z.string(),
            checks: z.object({
              database: z.string(),
            }),
          }),
        },
      },
    },
    async (request, reply) => {
      const timestamp = new Date().toISOString();
      const version = '1.0.0';

      try {
        // Test database connectivity
        fastify.db.prepare('SELECT 1').get();

        return {
          status: 'healthy',
          timestamp,
          version,
          checks: {
            database: 'ok',
          },
        };
      } catch (err) {
        request.log.error(err, 'Health check failed');

        return reply.code(503).send({
          status: 'unhealthy',
          timestamp,
          version,
          checks: {
            database: 'failed',
          },
        });
      }
    }
  );
};

export default healthRoutes;
