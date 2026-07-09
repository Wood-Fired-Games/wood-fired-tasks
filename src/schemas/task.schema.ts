import { z } from 'zod';
import { TASK_STATUSES, TASK_PRIORITIES } from '../types/task.js';
import { WSJF_HISTORY_TRIGGERS } from '../types/wsjf.js';
import {
  FibSchema,
  WsjfEvidenceSchema,
  WsjfLocksSchema,
  WsjfSourceSchema,
  WsjfClassificationSchema,
  WsjfFeaturesSchema,
} from './wsjf.schema.js';

/**
 * WSJF (task #627): the WSJF score payload accepted on create/update.
 *
 * ALL-FOUR-OR-NONE enforcement: the four component scores
 * (`value`, `timeCriticality`, `riskOpportunity`, `jobSize`) are each REQUIRED
 * inside this object, and the whole `wsjf` field is OPTIONAL on the task
 * schemas. So a caller either supplies a fully-scored task (all four present)
 * or omits `wsjf` entirely — a half-scored payload (e.g. only `value`) is
 * rejected because the other three components are missing. The structured
 * JSON metadata members are optional and reuse the validators from
 * `wsjf.schema.ts` (no redefinition — those are the authoritative shapes).
 */
export const WsjfWriteSchema = z
  .object({
    value: FibSchema,
    timeCriticality: FibSchema,
    riskOpportunity: FibSchema,
    jobSize: FibSchema,
    evidence: WsjfEvidenceSchema.optional().nullable(),
    locked: WsjfLocksSchema.optional().nullable(),
    source: WsjfSourceSchema.optional().nullable(),
    classifications: WsjfClassificationSchema.optional().nullable(),
    features: WsjfFeaturesSchema.optional().nullable(),
    // WSJF (#643): MANUAL-override marker. `true` routes the write through the
    // manual gate (enum + contradiction only — exempt from the classification /
    // evidence requirement) and stamps history `trigger='manual'`. The four
    // components stay REQUIRED here, so all-four-or-none still holds; a manual
    // caller supplies the per-component `locked` / `source` maps alongside.
    manual: z.boolean().optional(),
    // WSJF (#634): GENERIC history-trigger hint for the auto/classified path.
    // Overrides the default `'create'`/`'update'` trigger stamped on the
    // history row (e.g. `create_task` passes `'single_create'`, decompose
    // passes `'decompose'`). Ignored when `manual === true` (always `'manual'`).
    trigger: z.enum(WSJF_HISTORY_TRIGGERS).optional(),
  })
  .strict();

export type WsjfWriteInput = z.infer<typeof WsjfWriteSchema>;

/**
 * Wave 1.4 (task #312): verdict enum for the verification_evidence envelope.
 *
 * - PASS         — verifier confirmed the task's acceptance criteria.
 * - FAIL         — verifier ran the checks and at least one failed.
 * - PARTIAL      — some checks passed, some failed/skipped.
 * - NOT_VERIFIED — task closed without verification (auto-materialized by the
 *                  service layer when status -> done/closed and no evidence
 *                  was supplied). Explicitly distinct from "evidence absent
 *                  because the column is NULL" — see service updateTask.
 */
export const VERIFICATION_VERDICTS = ['PASS', 'FAIL', 'PARTIAL', 'NOT_VERIFIED'] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

/**
 * Per-check status — tighter than the top-level verdict because a single
 * check is a leaf (it either ran, or was skipped). Kept narrow on purpose so
 * the boundary rejects free-form strings ("ok", "good", etc.) and forces
 * verifier subagents to pick one of the three values.
 */
export const VERIFICATION_CHECK_STATUSES = ['PASS', 'FAIL', 'SKIP'] as const;
export type VerificationCheckStatus = (typeof VERIFICATION_CHECK_STATUSES)[number];

/**
 * Structured verification evidence stored in `tasks.verification_evidence`
 * as a JSON string (write: JSON.stringify; read: JSON.parse — both happen
 * inside the repository).
 *
 * Only `verdict` is required. Every other field is optional so the
 * auto-NOT_VERIFIED materialization on close (service-layer behavior — see
 * task.service.ts updateTask) can emit `{verdict: "NOT_VERIFIED"}` without
 * lying about a verified_at timestamp or fabricating a session id.
 *
 * Bounds:
 *  - `checks` capped at 50 entries (a single task does not realistically
 *    accumulate more verification gates than that; the cap bounds row size).
 *  - `evidence_url_or_text` capped at 2000 chars per entry.
 *  - identifier strings capped at 200 chars.
 */
export const VerificationEvidenceSchema = z
  .object({
    verdict: z.enum(VERIFICATION_VERDICTS),
    checks: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            status: z.enum(VERIFICATION_CHECK_STATUSES),
            evidence_url_or_text: z.string().max(2000),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    verifier_session_id: z.string().min(1).max(200).optional(),
    verifier_request_id: z.string().min(1).max(200).optional(),
    verified_at: z.string().datetime().optional(),
  })
  .strict();

export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

/**
 * CreateTaskSchema - validation for creating new tasks
 * Note: status is NOT included - new tasks always start as 'open'
 */
export const CreateTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255, 'Title must be 255 characters or less'),
  description: z.string().max(5000).optional().nullable(),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  project_id: z.number().int().positive('Project ID must be a positive integer'),
  parent_task_id: z.number().int().positive().optional().nullable(),
  estimated_minutes: z.number().int().min(0).max(10080).optional().nullable(),
  assignee: z.string().max(100).optional().nullable(),
  created_by: z.string().min(1, 'Created by is required').max(100),
  due_date: z
    .string()
    .datetime({ message: 'Due date must be ISO8601 format' })
    .optional()
    .nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional().default([]),
  // Wave 1.3 (task #311): free-form plain-text acceptance criteria. Clients
  // supply this on create to make "what would prove this is done?" structured
  // rather than buried in the description field. Multi-line markdown is fine.
  // No DB constraint — the 5000-char cap is a schema-layer business rule.
  acceptance_criteria: z.string().max(5000).optional().nullable(),
  // Phase 31 (Plan 31-01): optional FK fields. NOTE — these are server-derived
  // at route boundaries (T-31-02 of 31-01-PLAN threat register): downstream
  // plans STRIP body-supplied values and set them from request.user / Slack
  // lookup / MCP boot. They are accepted here only so service/repository
  // call sites can pass them through.
  created_by_user_id: z.number().int().positive().optional().nullable(),
  assignee_user_id: z.number().int().positive().optional().nullable(),
  // WSJF (task #627): optional WSJF score. Omit for an unscored task; supply
  // the full object (all four components) for a scored one. All-four-or-none
  // is enforced by WsjfWriteSchema (the four components are required there).
  wsjf: WsjfWriteSchema.optional().nullable(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/**
 * Client-facing variant of CreateTaskSchema for MCP tool registration
 * (Phase 31 review WR-04). Omits the server-derived FK fields
 * (`created_by_user_id`, `assignee_user_id`) so a client supplying them
 * gets a clear validation error instead of having the values silently
 * stripped by the route handler.
 *
 * The service-layer `CreateTaskSchema` still accepts them because
 * internal callers (routes, MCP handlers) populate them from
 * request.user / boot-time context. This separation makes the public
 * API surface honest about what fields clients control.
 */
export const CreateTaskClientSchema = CreateTaskSchema.omit({
  created_by_user_id: true,
  assignee_user_id: true,
}).strict();

export type CreateTaskClientInput = z.infer<typeof CreateTaskClientSchema>;

/**
 * UpdateTaskSchema - validation for updating tasks
 * All fields are optional (partial updates)
 */
export const UpdateTaskSchema = z
  .object({
    title: z.string().min(1).max(255),
    description: z.string().max(5000).nullable(),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    parent_task_id: z.number().int().positive().nullable(),
    estimated_minutes: z.number().int().min(0).max(10080).nullable(),
    assignee: z.string().max(100).nullable(),
    due_date: z.string().datetime().nullable(),
    tags: z.array(z.string().min(1).max(50)).max(20),
    // Phase 31 (Plan 31-01): optional FK field. Server-derived at the route
    // boundary (T-31-02) — downstream plans STRIP body-supplied values.
    assignee_user_id: z.number().int().positive().nullable(),
    // Wave 1.3 (task #311): patch acceptance_criteria on existing tasks.
    // Pass null to clear, a string to set. Same 5000-char cap as create.
    acceptance_criteria: z.string().max(5000).nullable(),
    // Wave 1.4 (task #312): structured verification evidence. The Zod enum on
    // `verdict` rejects unknown values at the boundary (the "unknown verdict =
    // 400" contract). Pass null to clear, an object to set. Stored as a JSON
    // string by the repository.
    verification_evidence: VerificationEvidenceSchema.nullable(),
    // WSJF (task #627): patch the WSJF score. `null` clears all four components;
    // an object sets them (all-four-or-none enforced by WsjfWriteSchema).
    wsjf: WsjfWriteSchema.nullable(),
    // Task #1004: atomic block-with-dependency. ONLY valid alongside
    // `status: 'blocked'` (the service rejects it otherwise — narrow semantics
    // by design). The service adds one `blocker -> this task` dependency edge
    // per id AND sets the status in ONE transaction: an invalid edge
    // (nonexistent blocker, self-reference, cycle) rolls back the whole call,
    // so an edge-less blocked state cannot be created through this affordance.
    blocked_by: z.array(z.number().int().positive()).min(1).max(50),
  })
  .partial();

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

/**
 * Client-facing variant of UpdateTaskSchema for MCP tool registration
 * (Phase 31 review WR-04). Omits the server-derived `assignee_user_id`
 * FK; clients update the FK indirectly by supplying `assignee` (an email
 * or display name), which the MCP handler resolves server-side via
 * `resolveAssigneeUserId`.
 */
export const UpdateTaskClientSchema = z
  .object({
    title: z.string().min(1).max(255),
    description: z.string().max(5000).nullable(),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    parent_task_id: z.number().int().positive().nullable(),
    estimated_minutes: z.number().int().min(0).max(10080).nullable(),
    assignee: z.string().max(100).nullable(),
    due_date: z.string().datetime().nullable(),
    tags: z.array(z.string().min(1).max(50)).max(20),
    // Wave 1.3 (task #311): clients can patch acceptance_criteria — it is
    // NOT server-derived, so it stays on the client-facing schema.
    acceptance_criteria: z.string().max(5000).nullable(),
    // Wave 1.4 (task #312): verifier subagents call update_task with this
    // envelope. It is NOT server-derived, so it stays on the client-facing
    // schema. Unknown verdicts get rejected at the Zod boundary.
    verification_evidence: VerificationEvidenceSchema.nullable(),
    // WSJF (task #627): clients may patch the WSJF score directly. `null` clears
    // it; an object sets all four components (all-four-or-none enforced).
    wsjf: WsjfWriteSchema.nullable(),
    // Task #1004: atomic block-with-dependency — see UpdateTaskSchema. Clients
    // pass this WITH `status: 'blocked'` so the blocking edge(s) and the status
    // flip commit together (no more edge-less blocked dead ends).
    blocked_by: z.array(z.number().int().positive()).min(1).max(50),
  })
  .partial()
  .strict();

export type UpdateTaskClientInput = z.infer<typeof UpdateTaskClientSchema>;

/**
 * CreateProjectSchema - validation for creating new projects
 */
/**
 * Project create/update schemas live in `project.schema.ts` (the single source
 * of truth that carries the WSJF `value_charter`). They are re-exported here so
 * every consumer that imports project schemas from this barrel — the REST
 * project routes and the remote MCP proxy among them — gets the
 * value_charter-aware definitions automatically.
 *
 * A local duplicate used to live here and silently lacked `value_charter`,
 * which stripped the charter on the entire remote (REST + proxy) write path
 * while the stdio path worked. Re-exporting keeps the two transports at parity
 * by construction; the `task.schema ≡ project.schema` referential-identity
 * guard in the project-tools tests fails loudly if they ever diverge again.
 */
export {
  CreateProjectSchema,
  UpdateProjectSchema,
  type CreateProjectInput,
  type UpdateProjectInput,
} from './project.schema.js';

/**
 * Pagination bounds applied to all list endpoints.
 *
 * `limit`  — page size; capped at 500 to bound query cost (GROUP_CONCAT
 *            over task_tags scales with row count).
 * `offset` — starting row, zero-based.
 *
 * Both fields default to safe values so existing callers that omit them
 * receive the first page (50 rows) rather than the full table.
 */
export const PaginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;

/**
 * Optional pagination — same bounds, but each field can be omitted entirely.
 * Used inside service-level filter parsing where defaults are applied later.
 */
export const PaginationOptionalSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export type PaginationOptionalInput = z.infer<typeof PaginationOptionalSchema>;

/**
 * Wrap a row schema in the standard paginated envelope:
 *   { data: [...], total, limit, offset }
 *
 * `total` is the unbounded count for the same filter set, so clients can
 * implement page navigation without re-issuing without filters.
 */
export function paginatedSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
}

/**
 * TaskFiltersSchema - validation for task filtering
 * All fields are optional. Includes pagination knobs (limit/offset).
 */
export const TaskFiltersSchema = z
  .object({
    project_id: z.number().int().positive(),
    status: z.enum(TASK_STATUSES),
    assignee: z.string(),
    tags: z.array(z.string()),
    due_before: z.string().datetime(),
    due_after: z.string().datetime(),
    updated_before: z.string().datetime(),
    updated_after: z.string().datetime(),
    search: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => s.trim().split(/\s+/).filter(Boolean).length <= 32, {
        message: 'Search query must contain at most 32 terms.',
      }),
    // Wave 1.4 (#312): verified-state filter. See TaskFilters.verified in
    // src/types/task.ts for semantics. The repository builds the
    // json_extract(verification_evidence, '$.verdict') predicate.
    verified: z.boolean(),
    limit: z.coerce.number().int().positive().max(500),
    offset: z.coerce.number().int().nonnegative(),
  })
  .partial();

export type TaskFiltersInput = z.infer<typeof TaskFiltersSchema>;

/**
 * ListTasksMcpSchema - filters plus MCP-only knobs.
 *
 * `verbose` opts back into full task bodies (description + audit fields).
 * Default response is a compact projection to keep MCP tool result payloads
 * within reasonable token budgets — full data is still available via get_task.
 */
export const ListTasksMcpSchema = TaskFiltersSchema.extend({
  verbose: z.boolean().optional(),
});

export type ListTasksMcpInput = z.infer<typeof ListTasksMcpSchema>;

/**
 * Strip heavy/audit fields from a task for use in list responses. Keeps the
 * fields a caller needs to decide whether to drill into a task with get_task.
 *
 * `parent_task_id` is optional because the remote REST TaskResponse does not
 * surface it; in-process Task does. The compact projection includes it when
 * present so callers can still see hierarchy.
 */
export function toCompactTask<
  T extends {
    id: number;
    title: string;
    status: string;
    priority: string;
    project_id: number;
    assignee: string | null;
    due_date: string | null;
    tags: string[];
    parent_task_id?: number | null;
  },
>(task: T) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    project_id: task.project_id,
    parent_task_id: task.parent_task_id ?? null,
    assignee: task.assignee,
    due_date: task.due_date,
    tags: task.tags,
  };
}

/**
 * ClaimTaskSchema - validation for claiming a task
 */
export const ClaimTaskSchema = z.object({
  assignee: z.string().min(1, 'Assignee is required').max(100),
});

export type ClaimTaskInput = z.infer<typeof ClaimTaskSchema>;

/**
 * CompletionReportSchema - validation for `getCompletionReport`.
 *
 * Caller supplies EITHER `days` (trailing N days from now, max 365) OR an
 * explicit `start`/`end` pair (both ISO8601, end >= start). Optional
 * `project_id` and `assignee` filters narrow the result set.
 */
export const CompletionReportSchema = z
  .object({
    days: z.number().int().min(1).max(365).optional(),
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
    project_id: z.number().int().positive().optional(),
    assignee: z.string().min(1).max(100).optional(),
  })
  .refine((v) => v.days !== undefined || (v.start !== undefined && v.end !== undefined), {
    message: 'Provide either `days` or both `start` and `end`',
  })
  .refine(
    (v) =>
      v.days !== undefined || (v.start !== undefined && v.end !== undefined && v.end >= v.start),
    { message: '`end` must be greater than or equal to `start`' },
  );

export type CompletionReportInput = z.infer<typeof CompletionReportSchema>;
