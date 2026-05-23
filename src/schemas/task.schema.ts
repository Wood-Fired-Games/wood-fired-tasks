import { z } from 'zod';
import { TASK_STATUSES, TASK_PRIORITIES } from '../types/task.js';

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
  due_date: z.string().datetime({ message: 'Due date must be ISO8601 format' }).optional().nullable(),
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
export const UpdateTaskSchema = z.object({
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
}).partial();

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

/**
 * Client-facing variant of UpdateTaskSchema for MCP tool registration
 * (Phase 31 review WR-04). Omits the server-derived `assignee_user_id`
 * FK; clients update the FK indirectly by supplying `assignee` (an email
 * or display name), which the MCP handler resolves server-side via
 * `resolveAssigneeUserId`.
 */
export const UpdateTaskClientSchema = z.object({
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
}).partial().strict();

export type UpdateTaskClientInput = z.infer<typeof UpdateTaskClientSchema>;

/**
 * CreateProjectSchema - validation for creating new projects
 */
export const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
  description: z.string().max(1000).optional().nullable(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

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
export const TaskFiltersSchema = z.object({
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
    .refine(
      (s) => s.trim().split(/\s+/).filter(Boolean).length <= 32,
      { message: 'Search query must contain at most 32 terms.' }
    ),
  limit: z.coerce.number().int().positive().max(500),
  offset: z.coerce.number().int().nonnegative(),
}).partial();

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
export function toCompactTask<T extends {
  id: number;
  title: string;
  status: string;
  priority: string;
  project_id: number;
  assignee: string | null;
  due_date: string | null;
  tags: string[];
  parent_task_id?: number | null;
}>(task: T) {
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
  .refine(
    (v) => v.days !== undefined || (v.start !== undefined && v.end !== undefined),
    { message: 'Provide either `days` or both `start` and `end`' }
  )
  .refine(
    (v) =>
      v.days !== undefined ||
      (v.start !== undefined && v.end !== undefined && v.end >= v.start),
    { message: '`end` must be greater than or equal to `start`' }
  );

export type CompletionReportInput = z.infer<typeof CompletionReportSchema>;
