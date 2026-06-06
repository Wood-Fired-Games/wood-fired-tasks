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
 *
 * task #393: retained ONLY as the legacy-principal fallback inside
 * `derivePrincipalId` for the (in practice impossible) case where a legacy
 * match somehow lacks an `apiKeyLabel`. The cap-attribution path no longer
 * reads the raw `x-api-key` header — see `derivePrincipalId`.
 */
function fingerprintApiKey(apiKey: string): string {
  return hashKey(apiKey).toString('hex').slice(0, 16);
}

/**
 * task #393: derive a stable per-principal identity from the AUTHENTICATED
 * request state populated by the auth chain (src/api/plugins/auth/index.ts),
 * NOT from the raw `x-api-key` header.
 *
 * Before this fix the SSE cap preHandler fingerprinted `request.headers
 * ['x-api-key']` directly. But the auth chain also accepts PAT
 * (`Authorization: Bearer wft_pat_...`) and session-cookie principals, which
 * send NO `x-api-key` header at all — so every such client collapsed to
 * `fingerprintApiKey('')`, sharing ONE cap bucket and defeating per-principal
 * caps entirely (Codex P0.1).
 *
 * Identity by auth method (the chain guarantees these slots are populated on
 * a successful match — events runs inside the authenticated `/api/v1` scope):
 *   - PAT     → `pat:<tokenId>`        (api_tokens.id; unique per token)
 *   - session → `session:<user.id>`    (users.id; unique per user)
 *   - legacy  → `legacy:<apiKeyLabel>` (derived API_KEYS label, e.g.
 *               `key_test-key`); falls back to `legacy:<keyHash>` ONLY if the
 *               label is somehow absent — the legacy strategy always supplies
 *               one, so this is belt-and-suspenders.
 *
 * The returned string is opaque to the SSEManager — it is stored as
 * `apiKeyFingerprint` (the existing per-principal cap key) and never logged
 * with the raw credential. PAT ids / user ids / labels are non-sensitive
 * audit identifiers, so no hashing is needed for those branches.
 */
function derivePrincipalId(request: FastifyRequest): string {
  switch (request.authMethod) {
    case 'pat':
      // tokenId is the api_tokens.id for a PAT match (never null here).
      return `pat:${request.tokenId ?? 'unknown'}`;
    case 'session':
      return `session:${request.user?.id ?? 'unknown'}`;
    case 'legacy': {
      if (request.apiKeyLabel !== undefined && request.apiKeyLabel.length > 0) {
        return `legacy:${request.apiKeyLabel}`;
      }
      // Fallback: hash the raw key so distinct unlabeled legacy keys still
      // get distinct buckets. The legacy strategy derives a label for every
      // configured entry, so this branch is defensive only.
      const apiKey = (request.headers['x-api-key'] as string) ?? '';
      return `legacy:${fingerprintApiKey(apiKey)}`;
    }
    default:
      // No recognised principal — the auth chain would have rejected the
      // request before this preHandler runs, so this is unreachable in
      // practice. Use a stable sentinel so an unexpected anonymous path does
      // not silently share the empty-string bucket of the old behaviour.
      return 'anonymous:unknown';
  }
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
        // task #393: the auth chain has already populated the principal slots
        // (request.authMethod / tokenId / user / apiKeyLabel). Derive the
        // per-principal cap identity from that authenticated state — NOT from
        // the raw x-api-key header, which is absent for PAT and session
        // principals (they previously all collapsed to one shared bucket).
        const apiKeyFingerprint = derivePrincipalId(request);
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
      // connection. Re-derive the per-principal identity (cheap, sync) so the
      // raw key is never persisted in the SSEManager — see task #194 / #393.
      const apiKeyFingerprint = derivePrincipalId(request);
      const ip = request.ip;

      const filters: { project_id?: number; event_types?: string[] } = request.query as any;
      const connectionId = randomUUID();

      // Get last event ID from SSE context or headers
      const lastEventIdHeader = request.headers['last-event-id'];
      const lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader as string, 10) : undefined;

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
    },
  );
};

export default eventsRoute;
