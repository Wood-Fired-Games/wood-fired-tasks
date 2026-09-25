/**
 * Security Audit finding M5 (task #1630) — REST audit-trail producer.
 *
 * Migration 018 created `audit_events`; task #1629/#1636 gave it an
 * append-only, hash-chained repository. This module makes the REST API the
 * first PRODUCER: one row per authenticated, state-changing HTTP request.
 *
 * ── Why a RESPONSE-phase hook (`onResponse`) ────────────────────────────
 * The trail must record ATTEMPTS, not just successes. A `preHandler`-phase
 * writer runs before the outcome is known and — worse — never runs at all
 * for a request the auth chain's own `preHandler` rejected. `onResponse`
 * fires after the reply has been flushed for EVERY routed request,
 * including the 403 that `enforceRequiredScope` sends, so a scope-denied
 * mutation attempt is recorded with its 403 rather than silently dropped.
 *
 * ── Non-fatal by construction ───────────────────────────────────────────
 * By the time `onResponse` runs, the client already has its status line and
 * body: nothing this hook does can change the response. On top of that
 * structural guarantee the hook is:
 *   - SYNCHRONOUS (callback form, not `async`) — better-sqlite3's `append`
 *     is synchronous, so there is no promise to leave unhandled and no way
 *     to produce an `unhandledRejection` that would take the process down;
 *   - wrapped in try/catch that swallows the throw but ALWAYS emits an
 *     `audit.append_failed` line at ERROR level. A dropped audit row is a
 *     security-relevant event and must never be silent.
 * The repository is read off the Fastify instance PER REQUEST (not captured
 * at registration), so a test can stub `append` to throw and prove the
 * status is unaffected.
 *
 * ── `action` is the route PATTERN, never the raw URL ─────────────────────
 * `action` is `"<METHOD> <route pattern>"` (e.g. `POST /api/v1/tasks/:id`),
 * taken from `request.routeOptions.url`. Using `request.url` would make the
 * column unbounded-cardinality (one distinct value per id ever touched),
 * would bake ids and query strings into a field meant for grouping, and
 * would duplicate what `resource_id` already carries.
 *
 * ── resource_type / resource_id ─────────────────────────────────────────
 * Both are derived MECHANICALLY from the route pattern (see
 * {@link deriveAuditResource}) so they cannot drift from the route table:
 *   - The pattern ends in a path parameter (`/api/v1/tasks/:id`,
 *     `/api/v1/tasks/:taskId/dependencies/:dependsOnId`): that parameter IS
 *     the addressed resource — `resource_id` is its value and
 *     `resource_type` is the nearest preceding static segment (`tasks`,
 *     `dependencies`).
 *   - The pattern ends in a static segment (`/api/v1/tasks`,
 *     `/api/v1/tasks/:id/comments`): the request addresses a COLLECTION, so
 *     `resource_type` is that segment and `resource_id` is NULL — the id of
 *     a row created by a POST is not part of the request, and migration 018
 *     made the column nullable for exactly this case. Any ids that WERE in
 *     the path (the parent task, above) are still captured under
 *     `metadata.params`, so the parent linkage is not lost.
 *
 * `resource_type` is the plural collection segment verbatim (`tasks`, not
 * `task`). Naive singularization is wrong often enough to matter
 * (`status` → `statu`, `search` → `searc`) and a hand-maintained
 * singular map is precisely the kind of table that silently drifts from the
 * routes; a value copied from the route pattern is always correct by
 * construction. Consumers that need to join against another producer's
 * naming should normalize at the read boundary (#1637).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { IAuditEventRepository } from '../../repositories/interfaces.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Append-only audit-event writer (Security Audit finding M5). Decorated
     * by `createServer` from the single instance built in `createApp`, which
     * is the EXCLUSIVE owner of the `audit_events` table's lifecycle — never
     * write that table any other way.
     */
    auditEventRepository: IAuditEventRepository;
  }
}

/**
 * Methods that do NOT produce an audit row.
 *
 * `GET` is the audit-irrelevant read verb. `HEAD` is included because it is
 * definitionally "GET without a body" and Fastify AUTO-REGISTERS a HEAD
 * route for every GET route (`exposeHeadRoutes`, on by default) — recording
 * them would contradict "reads produce nothing" while adding no signal.
 * Every other verb (POST/PUT/PATCH/DELETE, and any future one) is recorded:
 * the default is to audit, so a newly added mutating verb is covered without
 * anyone remembering to update this set.
 */
export const AUDIT_EXEMPT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * Fallback `resource_type` for a route pattern with no static segment at all
 * (`/:id`). The column is NOT NULL, so it needs a sentinel rather than a
 * skipped write — dropping the row would be worse than an imprecise type.
 */
export const UNKNOWN_RESOURCE_TYPE = 'unknown';

/** `"<METHOD> <route pattern>"` — see the module note on cardinality. */
export function buildAuditAction(method: string, routePattern: string): string {
  return `${method.toUpperCase()} ${routePattern}`;
}

/** True for a Fastify path-parameter or wildcard segment. */
function isParamSegment(segment: string): boolean {
  return segment.startsWith(':') || segment === '*';
}

/**
 * Split a route pattern into `{ resourceType, resourceId }` per the rules in
 * the module doc comment. Pure and exported so the mapping is unit-testable
 * without an HTTP round trip.
 *
 * `params` is typed `unknown` because `request.params` is `unknown` until a
 * route schema narrows it; the guard below is what makes reading it safe.
 */
export function deriveAuditResource(
  routePattern: string,
  params: unknown,
): { resourceType: string; resourceId: string | null } {
  const segments = routePattern.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];

  if (last === undefined) {
    return { resourceType: UNKNOWN_RESOURCE_TYPE, resourceId: null };
  }

  // Collection-addressing route (`/api/v1/tasks`, `/api/v1/tasks/:id/comments`).
  if (!isParamSegment(last)) {
    return { resourceType: last, resourceId: null };
  }

  // Instance-addressing route: the trailing parameter names the resource.
  const paramName = last === '*' ? '*' : last.slice(1);
  const bag =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const rawId = bag[paramName];

  let resourceType = UNKNOWN_RESOURCE_TYPE;
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const segment = segments[i] as string;
    if (!isParamSegment(segment)) {
      resourceType = segment;
      break;
    }
  }

  return {
    resourceType,
    resourceId: rawId === undefined || rawId === null ? null : String(rawId),
  };
}

/**
 * Action-specific detail for the `metadata` JSON blob.
 *
 * `status` is the whole reason the hook is response-phase: it is how a
 * scope-gate 403 (or any other rejection) is distinguishable from an applied
 * mutation. `authMethod` records HOW the principal proved identity, and
 * `params` preserves path ids that `resource_id` alone cannot carry (the
 * parent task of a nested create). Request BODIES are deliberately NOT
 * recorded — they routinely carry free text and would turn the audit table
 * into an unreviewed copy of user content.
 */
function buildAuditMetadata(request: FastifyRequest, reply: FastifyReply): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    status: reply.statusCode,
    authMethod: request.authMethod,
  };
  const params = request.params;
  if (typeof params === 'object' && params !== null && Object.keys(params).length > 0) {
    metadata['params'] = params;
  }
  return metadata;
}

/**
 * Build and append the row for one request, or return without writing when
 * the request is out of scope (read verb / unauthenticated / unrouted).
 *
 * Throwing is FINE here — the caller converts any throw into an
 * `audit.append_failed` error log.
 */
function recordAuditEvent(
  fastify: { auditEventRepository: IAuditEventRepository },
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (AUDIT_EXEMPT_METHODS.has(request.method.toUpperCase())) {
    return;
  }

  // No principal → nothing to attribute the action to. This is the 401 path
  // (and the anonymous `skipAuth` routes): the auth chain already emits a
  // structured `auth.failure` line for those, which is the correct home for
  // a credential-less attempt. `audit_events.actor_id` is NOT NULL by
  // design — it is a record of WHO did WHAT, not a general request log.
  const user = request.user;
  if (user === null || user === undefined) {
    return;
  }

  // Undefined for a request that matched no route (Fastify's default 404
  // handler still fires onResponse). With no pattern there is nothing
  // low-cardinality to record, and such a request changed nothing.
  const routePattern = request.routeOptions.url;
  if (routePattern === undefined) {
    return;
  }

  const { resourceType, resourceId } = deriveAuditResource(routePattern, request.params);

  fastify.auditEventRepository.append({
    actorType: user.isServiceAccount ? 'service_account' : 'user',
    // TEXT column: `users.id` is numeric, other actor kinds may not be.
    actorId: String(user.id),
    tokenId: request.tokenId === null ? null : String(request.tokenId),
    action: buildAuditAction(request.method, routePattern),
    resourceType,
    resourceId,
    requestId: request.id,
    metadata: buildAuditMetadata(request, reply),
  });
}

const auditTrailImpl: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onResponse', (request, reply, done) => {
    try {
      recordAuditEvent(fastify, request, reply);
    } catch (err) {
      // NEVER rethrow: the response is already on the wire, and an audit
      // outage must not become an availability outage. But never silent
      // either — a dropped audit row is itself a security event.
      request.log.error(
        {
          err,
          requestId: request.id,
          method: request.method,
          route: request.routeOptions.url ?? null,
          statusCode: reply.statusCode,
        },
        'audit.append_failed',
      );
    }
    done();
  });
};

/**
 * fp() wrap — same non-negotiable rationale as the auth chain: without it
 * the `onResponse` hook would only fire for routes registered INSIDE this
 * plugin, and every sibling route in the `/api/v1` scope would go
 * unrecorded. `{ name: 'wft-audit-trail' }` makes the registration
 * introspectable via `fastify.hasPlugin(...)`.
 */
const auditTrailPlugin = fp(auditTrailImpl, {
  name: 'wft-audit-trail',
  fastify: '5.x',
});

export default auditTrailPlugin;
