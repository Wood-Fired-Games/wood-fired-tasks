import { z } from 'zod';
import { TASK_STATUSES, TASK_PRIORITIES } from '../../../types/task.js';

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
