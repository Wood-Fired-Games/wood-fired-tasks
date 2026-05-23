import { z } from 'zod';
import { TASK_STATUSES, TASK_PRIORITIES } from '../../../types/task.js';
import { VerificationEvidenceSchema } from '../../../schemas/task.schema.js';

/**
 * TaskResponseSchema - Zod schema for task response
 */
export const TaskResponseSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  project_id: z.number(),
  project_name: z.string(),
  parent_task_id: z.number().nullable(),
  estimated_minutes: z.number().nullable(),
  assignee: z.string().nullable(),
  created_by: z.string(),
  due_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
  claimed_at: z.string().nullable(),
  tags: z.array(z.string()),
  /**
   * Wave 1.3 (task #311): optional free-form acceptance criteria (markdown).
   * Heavy text field — full-task projections (`GET /tasks/:id`, MCP get_task,
   * REST `POST /tasks` response) include it; the compact `toCompactTask`
   * projection used by `list_tasks` does NOT.
   */
  acceptance_criteria: z.string().nullable(),
  /**
   * Wave 1.4 (task #312): structured verification evidence (verdict + checks).
   * The REST list endpoint (`GET /tasks`) strips this by default — pass
   * `?include=verification` to opt back in. Single-task GET and create/update
   * response bodies always include it.
   */
  verification_evidence: VerificationEvidenceSchema.nullable(),
});

/**
 * Legacy bare-array task list shape. Retained for places that still want
 * the array directly (currently none after the pagination rollout, but kept
 * so future internal callers have a typed handle).
 */
export const TaskListResponseSchema = z.array(TaskResponseSchema);

/**
 * Paginated task list envelope returned by GET /tasks and GET /tasks/:id/subtasks.
 * Shape: `{ data: TaskResponse[], total, limit, offset }`.
 */
export const TaskListPaginatedResponseSchema = z.object({
  data: z.array(TaskResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

/**
 * ClaimRequestSchema - validation for claim request body
 */
export const ClaimRequestSchema = z.object({
  assignee: z.string().min(1, 'Assignee is required').max(100),
});

/**
 * ClaimResponseSchema - same as TaskResponse (returns the claimed task)
 */
export const ClaimResponseSchema = TaskResponseSchema;

/**
 * ConflictResponseSchema - returned when claim conflicts with existing state
 */
export const ConflictResponseSchema = z.object({
  error: z.literal('CONFLICT'),
  message: z.string(),
});

/**
 * ErrorResponseSchema - shared error response format
 */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

/**
 * CompletionReportQuerySchema - REST query parameters for
 * `GET /api/v1/tasks/completion-report`. Mirrors the in-process
 * `CompletionReportSchema` (services/schemas/task.schema.ts) but uses
 * `z.coerce` for numeric fields so URL strings are accepted.
 *
 * Caller must supply EITHER `days` OR both `start` and `end`. Refinements
 * mirror the service-layer schema exactly so REST and direct-service paths
 * produce identical validation errors.
 */
export const CompletionReportQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).optional(),
    start: z.string().datetime().optional(),
    end: z.string().datetime().optional(),
    project_id: z.coerce.number().int().positive().optional(),
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

/**
 * CompletionReportResponseSchema - REST response envelope for
 * `GET /api/v1/tasks/completion-report`. Shape mirrors
 * `TaskService.CompletionReport` (services/task.service.ts).
 */
export const CompletionReportResponseSchema = z.object({
  range: z.object({
    start: z.string(),
    end: z.string(),
  }),
  total: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      project_id: z.number(),
      project_name: z.string(),
      assignee: z.string().nullable(),
      priority: z.enum(TASK_PRIORITIES),
      created_at: z.string(),
      completed_at: z.string(),
      time_to_complete_seconds: z.number(),
    })
  ),
  by_project: z.array(
    z.object({ project_id: z.number(), count: z.number().int().nonnegative() })
  ),
  by_assignee: z.array(
    z.object({ assignee: z.string(), count: z.number().int().nonnegative() })
  ),
  by_priority: z.array(
    z.object({ priority: z.enum(TASK_PRIORITIES), count: z.number().int().nonnegative() })
  ),
  daily_throughput: z.array(
    z.object({ date: z.string(), count: z.number().int().nonnegative() })
  ),
});
