import { z } from 'zod';

export const CreateCommentSchema = z.object({
  task_id: z.number().int().positive(),
  author: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
  // Phase 31 (Plan 31-01): optional FK field. Server-derived at the route
  // boundary (T-31-02) — downstream plans STRIP body-supplied values and
  // set them from request.user / Slack lookup / MCP boot.
  author_user_id: z.number().int().positive().optional().nullable(),
});

export const CommentResponseSchema = z.object({
  id: z.number(),
  task_id: z.number(),
  author: z.string(),
  content: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/**
 * Pagination query params for the comment-list endpoint.
 * Mirrors the task/project list bounds so the API surface stays uniform.
 */
export const CommentListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type CommentListQueryInput = z.infer<typeof CommentListQuerySchema>;
