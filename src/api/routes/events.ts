import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const EventFiltersSchema = z.object({
  project_id: z.coerce.number().optional(),
  event_types: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((t) => t.trim()) : undefined)),
});

const eventsRoute: FastifyPluginAsyncZod = async (server) => {
  server.get(
    '/',
    {
      sse: true, // Enable SSE for this route
      schema: {
        tags: ['Events'],
        description: 'Subscribe to real-time task and project events via Server-Sent Events',
        querystring: EventFiltersSchema,
        response: {
          200: z.void(), // SSE stream, no structured response
        },
      },
    } as any,
    async (request, reply) => {
      // @fastify/sse only creates reply.sse when Accept: text/event-stream is present
      if (!reply.sse) {
        return reply.code(400).send({
          error: 'BAD_REQUEST',
          message: 'This endpoint requires Accept: text/event-stream header for SSE connections.',
        });
      }

      const filters: { project_id?: number; event_types?: string[] } = request.query as any;
      const connectionId = randomUUID();

      // Get last event ID from SSE context or headers
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId = lastEventIdHeader
        ? parseInt(lastEventIdHeader as string, 10)
        : undefined;

      // Keep connection alive
      reply.sse.keepAlive();

      // Register connection with SSEManager
      server.sseManager.addConnection(connectionId, reply, filters, lastEventId);

      // Send initial connected event
      await reply.sse.send({
        event: 'connected',
        data: JSON.stringify({ connectionId, filters }),
      });
    }
  );
};

export default eventsRoute;
