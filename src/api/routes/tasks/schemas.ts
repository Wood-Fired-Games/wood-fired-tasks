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
  assignee: z.string().nullable(),
  created_by: z.string(),
  due_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  tags: z.array(z.string()),
});

export const TaskListResponseSchema = z.array(TaskResponseSchema);

/**
 * ErrorResponseSchema - shared error response format
 */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
