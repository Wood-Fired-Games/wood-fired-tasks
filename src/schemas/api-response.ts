import { z } from 'zod';
import { TaskResponseSchema } from '../api/routes/tasks/schemas.js';
import { ProjectResponseSchema } from '../api/routes/projects/schemas.js';

/**
 * Shared REST/API RESPONSE validators for the highest-risk client paths.
 *
 * ── Trust boundary ─────────────────────────────────────────────────────────
 * The CLI (`src/cli/api/client.ts`) and the remote MCP proxy
 * (`src/mcp/remote/rest-client.ts`) talk to the REST API over HTTP and have to
 * trust whatever JSON comes back. Before task #774 they cast the parsed body
 * straight to the inferred type (`response.json() as T`) — a malformed,
 * truncated, or version-skewed response (wrong types, missing required fields,
 * a stray HTML error page that still parses as JSON) would flow through
 * untyped and surface as a confusing downstream `undefined`/NaN rather than a
 * clear "bad response from server" error.
 *
 * These helpers re-use the SAME Zod response schemas the server validates its
 * own output against (`TaskResponseSchema` / `ProjectResponseSchema` — the
 * single source of truth that `TaskResponse` / `ProjectResponse` are inferred
 * from), so there is no shape duplication: if the server schema changes, these
 * validators change with it. We deliberately scope runtime validation to the
 * task / project / list response shapes (the highest-risk, highest-traffic
 * adapters). Comment / dependency / health / WSJF responses remain typed-only
 * casts for now and are documented as deferred at their call sites.
 *
 * Why pure-zod imports are safe here: the response schema modules pulled in
 * above depend ONLY on `zod` and on plain const/type modules (`types/task`,
 * `schemas/wsjf`, `schemas/project`) — no DB, service, or server runtime. So
 * importing them from the CLI or from the minimal stdio MCP subprocess does
 * not drag in the server.
 */

/** Raised when a REST response body fails its schema check at the client boundary. */
export class ApiResponseValidationError extends Error {
  constructor(
    message: string,
    /** The endpoint that produced the bad body, for tracing. */
    public readonly endpoint: string,
    /** The underlying Zod issue summary. */
    public readonly issues: string,
  ) {
    super(message);
    this.name = 'ApiResponseValidationError';
  }
}

/**
 * Parse `payload` against `schema`, throwing a clear, endpoint-tagged error on
 * failure instead of letting an invalid shape leak downstream as `T`.
 */
export function parseResponse<T>(schema: z.ZodType<T>, payload: unknown, endpoint: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ApiResponseValidationError(
      `Invalid response from ${endpoint}: server returned an unexpected shape (${issues})`,
      endpoint,
      issues,
    );
  }
  return result.data;
}

/**
 * List-response parser that accepts BOTH the pagination envelope
 * `{ data, total, limit, offset }` AND a bare array (legacy servers that
 * pre-date pagination), then validates every row against `itemSchema`.
 *
 * Returns a normalized envelope. A bare array is wrapped with `total` =
 * `length` and sensible pagination defaults — matching the long-standing
 * `asPage` behavior, but now every row is schema-checked rather than cast.
 *
 * Unlike the old loose `asPage`/`unwrapPage` (which silently returned `[]` on
 * an unexpected shape), an outright non-array / non-envelope body now throws a
 * clear error — a silently empty list hid real server faults.
 */
export function parsePaginatedResponse<T>(
  itemSchema: z.ZodType<T>,
  payload: unknown,
  endpoint: string,
): { data: T[]; total: number; limit: number; offset: number } {
  if (Array.isArray(payload)) {
    const data = parseResponse(z.array(itemSchema), payload, endpoint);
    return { data, total: data.length, limit: data.length, offset: 0 };
  }
  const envelopeSchema = z.object({
    data: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
  return parseResponse(envelopeSchema, payload, endpoint);
}

/** Convenience: validate a single task response body. */
export function parseTaskResponse(payload: unknown, endpoint: string) {
  return parseResponse(TaskResponseSchema, payload, endpoint);
}

/** Convenience: validate a single project response body. */
export function parseProjectResponse(payload: unknown, endpoint: string) {
  return parseResponse(ProjectResponseSchema, payload, endpoint);
}

/** Convenience: validate a task list (envelope or bare array). */
export function parseTaskListResponse(payload: unknown, endpoint: string) {
  return parsePaginatedResponse(TaskResponseSchema, payload, endpoint);
}

/** Convenience: validate a project list (envelope or bare array). */
export function parseProjectListResponse(payload: unknown, endpoint: string) {
  return parsePaginatedResponse(ProjectResponseSchema, payload, endpoint);
}
