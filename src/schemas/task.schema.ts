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
  assignee: z.string().max(100).optional().nullable(),
  created_by: z.string().min(1, 'Created by is required').max(100),
  due_date: z.string().datetime({ message: 'Due date must be ISO8601 format' }).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional().default([]),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/**
 * UpdateTaskSchema - validation for updating tasks
 * All fields are optional (partial updates)
 */
export const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(5000).nullable(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  assignee: z.string().max(100).nullable(),
  due_date: z.string().datetime().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20),
}).partial();

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

/**
 * CreateProjectSchema - validation for creating new projects
 */
export const CreateProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be 100 characters or less'),
  description: z.string().max(1000).optional().nullable(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/**
 * TaskFiltersSchema - validation for task filtering
 * All fields are optional
 */
export const TaskFiltersSchema = z.object({
  project_id: z.number().int().positive(),
  status: z.enum(TASK_STATUSES),
  assignee: z.string(),
  tags: z.array(z.string()),
  due_before: z.string().datetime(),
  due_after: z.string().datetime(),
  search: z.string().min(1).max(200),
}).partial();

export type TaskFiltersInput = z.infer<typeof TaskFiltersSchema>;
