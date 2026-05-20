import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { hashKey } from '../plugins/auth.js';

/**
 * task #194: derive a short, non-reversible fingerprint for the supplied API
 * key so the SSE connection map can attribute caps without holding the raw
 * credential. SHA-256 (same hash the auth plugin uses for constant-time
 * comparison) + 16 hex chars = 64 bits of fingerprint space — more than
 * enough collision resistance for the small set of configured keys, and
 * short enough that a heap dump reveals nothing actionable.
 */
function fingerprintApiKey(apiKey: string): string {
  return hashKey(apiKey).toString('hex').slice(0, 16);
}

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
      // task #185: enforce per-key / per-IP / global SSE connection caps in
      // a `preHandler` hook so the rejection short-circuits BEFORE the
      // @fastify/sse plugin's wrapped handler sets up the SSE context
      // (Content-Type: text/event-stream headers + heartbeat timer). If we
      // sent the 429 from inside the wrapped handler, the response would
      // hang under `inject()` because the SSE context tries to keep the
      // stream open. The preHandler runs strictly before the SSE wrap.
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        // Auth plugin has already validated X-API-Key — it's guaranteed
        // to be a non-empty string at this point.
        // task #194: hash to a fingerprint immediately; the raw key never
        // enters the SSEManager.
        const apiKey = (request.headers['x-api-key'] as string) ?? '';
        const apiKeyFingerprint = fingerprintApiKey(apiKey);
        const ip = request.ip;
        const decision = server.sseManager.canAccept(apiKeyFingerprint, ip);
        if (!decision.ok) {
          const limitLabel =
            decision.reason === 'per-key'
              ? 'per-key'
              : decision.reason === 'per-ip'
                ? 'per-IP'
                : 'global';
          return reply
            .header('Retry-After', String(decision.retryAfterSeconds))
            .code(429)
            .send({
              error: 'TOO_MANY_CONNECTIONS',
              message: `Too many SSE connections (limit: ${limitLabel}). Retry in ${decision.retryAfterSeconds} seconds.`,
            });
        }
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

      // Cap check already passed in preHandler — proceed to register the
      // connection. Re-derive the fingerprint (cheap, sync) so the raw key
      // is never persisted in the SSEManager — see task #194.
      const apiKey = (request.headers['x-api-key'] as string) ?? '';
      const apiKeyFingerprint = fingerprintApiKey(apiKey);
      const ip = request.ip;

      const filters: { project_id?: number; event_types?: string[] } = request.query as any;
      const connectionId = randomUUID();

      // Get last event ID from SSE context or headers
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId = lastEventIdHeader
        ? parseInt(lastEventIdHeader as string, 10)
        : undefined;

      // Keep connection alive
      reply.sse.keepAlive();

      // Register connection with SSEManager (with per-key/per-IP attribution).
      // task #194: pass only the fingerprint — the raw key stays scoped to
      // this request handler.
      server.sseManager.addConnection(connectionId, reply, filters, lastEventId, {
        apiKeyFingerprint,
        ip,
      });

      // Send initial connected event
      await reply.sse.send({
        event: 'connected',
        data: JSON.stringify({ connectionId, filters }),
      });
    }
  );
};

export default eventsRoute;
