/**
 * Security Audit finding M5 (task #1637) — READ-ONLY audit-trail query surface.
 *
 * `audit_events` is written by the REST lifecycle hook (#1630) and the stdio
 * MCP tool layer (#1632), but until this module existed the only way to answer
 * "who did what" was to open the SQLite file. That is not an audit trail an
 * operator can actually use, and handing out filesystem access to read it is
 * strictly worse than an authenticated, tier-gated endpoint.
 *
 * ── Read-only by construction ───────────────────────────────────────────────
 * Exactly ONE verb is registered here: `GET /api/v1/audit-events` (Fastify's
 * `exposeHeadRoutes` adds the matching `HEAD`, which is definitionally the same
 * read). There is deliberately no POST/PUT/PATCH/DELETE — the table is
 * append-only at the SQL layer (migration 018 triggers), at the type layer
 * (`IAuditEventRepository` has no update/delete member) and now at the HTTP
 * layer too. `src/api/__tests__/audit-query.test.ts` enumerates the server's
 * built route table and fails if any write verb ever appears under this prefix,
 * so the guarantee is asserted rather than merely commented.
 *
 * ── All querying goes through the repository ────────────────────────────────
 * `AuditEventRepository` is the EXCLUSIVE owner of the `audit_events`
 * lifecycle. This module issues no SQL and re-implements no filter logic; it
 * maps one of three query modes onto the repository's three limit-bounded,
 * newest-first helpers (`findByActor` / `findByResource` / `findByTimeRange`).
 *
 * ── Why the modes are mutually exclusive ────────────────────────────────────
 * The repository intentionally exposes three narrow, individually-bounded
 * queries rather than one open-ended filter builder, and combining them in the
 * route would mean either intersecting result sets in memory (wrong: each side
 * is already truncated at its own limit, so the intersection silently drops
 * rows) or writing new SQL here (forbidden). So the querystring must select
 * EXACTLY ONE mode, and anything else is a 400 at the boundary:
 *   - `?actor_id=…`                        → findByActor
 *   - `?resource_type=…&resource_id=…`     → findByResource   (both required)
 *   - `?start=…&end=…`                     → findByTimeRange  (both required)
 * An unfiltered "dump the whole trail" mode is deliberately absent: there is no
 * unbounded repository helper to serve it, and a full-table read is exactly the
 * shape this surface should not have.
 *
 * ── Timestamp normalization ─────────────────────────────────────────────────
 * `audit_events.timestamp` stores SQLite's `datetime('now')` output —
 * `YYYY-MM-DD HH:MM:SS`, UTC, space-separated — and `findByTimeRange` compares
 * it as TEXT. Passing a raw ISO-8601 string through would compare `'T'` (0x54)
 * against `' '` (0x20) and sort every stored row BEFORE every supplied bound,
 * making the filter silently return nothing. The route therefore accepts
 * ISO-8601 (the format the rest of this API speaks) and converts it to the
 * stored form before handing it to the repository — see
 * {@link toStoredTimestamp}.
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────
 * Nothing credential-bearing can surface here. `token_id` is the `api_tokens.id`
 * ROW ID (`String(request.tokenId)` in `src/api/hooks/audit-trail.ts`), never a
 * token, prefix, suffix or hash. `metadata` is built by
 * `buildAuditMetadata` from `{ status, authMethod, params }` only — request
 * bodies and headers are deliberately never recorded. `prev_hash` / `row_hash`
 * are SHA-256 digests over that same non-secret content and are what an
 * operator needs to check the chain, so they are included.
 *
 * ── Authorization ───────────────────────────────────────────────────────────
 * `requiredScope: 'admin'` — the trail names every actor and every resource in
 * the database, which is a strictly higher privilege than reading any single
 * project's tasks. The project-binding table classifies this route `deny`
 * (`src/api/plugins/auth/project-binding.ts`); see that module's table for the
 * argument.
 *
 * Note: this endpoint records nothing about itself. #1630's producer is
 * GET/HEAD-exempt by design, so reads of the trail write no rows. That is
 * intended — a read-log would grow without bound and add no accountability the
 * access log does not already carry.
 */
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ErrorResponseSchema } from '../tasks/schemas.js';
import type { AuditEventRow } from '../../../repositories/interfaces.js';

/**
 * Hard ceiling on how many rows a single request may pull out of the
 * repository. 500 is the project's existing list-endpoint ceiling (see
 * `QueryTaskFiltersSchema` in `src/api/routes/tasks/index.ts`) — reused rather
 * than reinvented so every paginated surface bounds payload + query cost the
 * same way.
 */
export const AUDIT_QUERY_LIMIT_MAX = 500;

/** Default page size when the caller does not ask for one. */
export const AUDIT_QUERY_LIMIT_DEFAULT = 50;

/**
 * Convert an ISO-8601 instant to the `YYYY-MM-DD HH:MM:SS` UTC form stored in
 * `audit_events.timestamp`, so the repository's TEXT range comparison is
 * meaningful. The input has already been validated as ISO-8601 by the
 * querystring schema, so `Date` parsing cannot produce `Invalid Date` here.
 *
 * Sub-second precision is truncated because the stored column has none:
 * keeping the fraction on the bound would make `end` compare as GREATER than
 * an equal-second row ("…10:00:00.500" > "…10:00:00"), which is harmless for
 * `end` but would wrongly EXCLUDE that row from `start`. Truncating both keeps
 * the range inclusive at whole-second resolution, matching the data.
 */
export function toStoredTimestamp(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * One audit row as returned over HTTP. Field-for-field the repository's
 * `AuditEventRow`; the schema is explicit (rather than passthrough) so a column
 * added to the table in a future migration cannot start leaking through this
 * endpoint without someone adding it here on purpose.
 */
const AuditEventResponseSchema = z.object({
  id: z.number().int(),
  timestamp: z.string(),
  actor_type: z.string(),
  actor_id: z.string(),
  token_id: z.string().nullable(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string().nullable(),
  request_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  prev_hash: z.string().nullable(),
  row_hash: z.string().nullable(),
});

/**
 * Paginated envelope. Mirrors the project's `{ data, limit, offset }` list
 * shape; `count` is `data.length` rather than a whole-table `total` because the
 * repository exposes no COUNT helper and this module may not add SQL of its
 * own. A response whose `count` equals `limit` should be treated as "there may
 * be more".
 */
const AuditEventListResponseSchema = z.object({
  data: z.array(AuditEventResponseSchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

/**
 * Querystring contract.
 *
 * `limit` REJECTS an over-ceiling request with a 400 rather than silently
 * clamping it — the same `.max(500)` treatment `GET /api/v1/tasks` gives, and
 * the honest answer: a caller who asked for 5000 rows and received 500 without
 * being told has no way to know its view is truncated.
 *
 * `offset + limit` is what the repository is actually asked for (the helpers
 * take a limit only, so the offset is applied by slicing the bounded window).
 * The sum is therefore ALSO ceiling-checked: without that, `offset=10000` would
 * turn a 500-row bound into a 10 500-row read. Paging beyond 500 rows means
 * narrowing the filter, which for an audit trail is the right instruction.
 */
const AuditQuerySchema = z
  .object({
    actor_id: z.string().min(1).max(200).optional(),
    resource_type: z.string().min(1).max(100).optional(),
    resource_id: z.string().min(1).max(200).optional(),
    start: z.string().datetime({ offset: true }).optional(),
    end: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(AUDIT_QUERY_LIMIT_MAX)
      .default(AUDIT_QUERY_LIMIT_DEFAULT),
    offset: z.coerce.number().int().nonnegative().default(0),
  })
  .refine((q) => q.offset + q.limit <= AUDIT_QUERY_LIMIT_MAX, {
    message: `offset + limit must not exceed ${AUDIT_QUERY_LIMIT_MAX}; narrow the filter instead.`,
    path: ['offset'],
  })
  .refine((q) => selectedModes(q).length === 1, {
    message:
      'Specify exactly one filter mode: `actor_id`, or `resource_type` + `resource_id`, or `start` + `end`.',
    path: ['actor_id'],
  })
  .refine((q) => (q.resource_type === undefined) === (q.resource_id === undefined), {
    message: '`resource_type` and `resource_id` must be supplied together.',
    path: ['resource_id'],
  })
  .refine((q) => (q.start === undefined) === (q.end === undefined), {
    message: '`start` and `end` must be supplied together.',
    path: ['end'],
  });

type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * Which of the three modes the querystring names. A mode counts as "named" as
 * soon as ANY of its fields is present, so `?actor_id=x&start=…` reports two
 * modes and is rejected — rather than one field being silently ignored.
 */
function selectedModes(q: {
  // `| undefined` explicitly, not just `?`: the repo compiles with
  // `exactOptionalPropertyTypes`, under which a Zod-inferred
  // `actor_id?: string | undefined` is NOT assignable to `actor_id?: string`.
  actor_id?: string | undefined;
  resource_type?: string | undefined;
  resource_id?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
}): string[] {
  const modes: string[] = [];
  if (q.actor_id !== undefined) modes.push('actor');
  if (q.resource_type !== undefined || q.resource_id !== undefined) modes.push('resource');
  if (q.start !== undefined || q.end !== undefined) modes.push('time_range');
  return modes;
}

const auditRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET / → GET /api/v1/audit-events. The ONLY verb on this surface.
  fastify.get(
    '/',
    {
      // Security Audit finding M1 (task #1622) + M5 (task #1637): the audit
      // trail spans every actor and every project, so it is `admin`, not the
      // `read` tier a per-project list endpoint carries.
      config: { requiredScope: 'admin' },
      schema: {
        tags: ['audit'],
        description:
          'Read the append-only audit trail (admin scope). Specify exactly one ' +
          'filter mode: `actor_id`; or `resource_type` + `resource_id`; or ' +
          '`start` + `end` (ISO-8601, inclusive). Rows are newest-first. ' +
          '`limit` defaults to ' +
          `${AUDIT_QUERY_LIMIT_DEFAULT} and, together with \`offset\`, may not exceed ` +
          `${AUDIT_QUERY_LIMIT_MAX}. This endpoint is read-only — the trail is ` +
          'append-only and exposes no write verb.',
        querystring: AuditQuerySchema,
        response: {
          200: AuditEventListResponseSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as AuditQuery;
      // The repository helpers are limit-only, so ask for the whole window the
      // page sits in and slice. `offset + limit` is ceiling-checked by the
      // schema above, so this is never a request for more than
      // AUDIT_QUERY_LIMIT_MAX rows.
      const window = query.offset + query.limit;
      const rows = queryTrail(fastify.auditEventRepository, query, window);
      const data = rows.slice(query.offset, query.offset + query.limit);

      return reply.send({
        data,
        limit: query.limit,
        offset: query.offset,
        count: data.length,
      });
    },
  );
};

/**
 * Dispatch to the repository helper for the single validated mode. Exhaustive
 * by construction: the schema guarantees exactly one mode is selected and that
 * each mode's fields arrive together, so every branch's fields are non-null
 * when it is taken.
 */
function queryTrail(
  repository: {
    findByActor(actorId: string, limit: number): AuditEventRow[];
    findByResource(resourceType: string, resourceId: string, limit: number): AuditEventRow[];
    findByTimeRange(start: string, end: string, limit: number): AuditEventRow[];
  },
  query: AuditQuery,
  limit: number,
): AuditEventRow[] {
  if (query.actor_id !== undefined) {
    return repository.findByActor(query.actor_id, limit);
  }
  if (query.resource_type !== undefined && query.resource_id !== undefined) {
    return repository.findByResource(query.resource_type, query.resource_id, limit);
  }
  if (query.start !== undefined && query.end !== undefined) {
    return repository.findByTimeRange(
      toStoredTimestamp(query.start),
      toStoredTimestamp(query.end),
      limit,
    );
  }
  // Unreachable: the "exactly one mode" refinement rejects this at the
  // boundary. Throwing (rather than returning []) keeps a schema regression
  // loud instead of silently serving an empty trail.
  throw new Error('audit query reached the handler with no filter mode selected');
}

export default auditRoutes;
