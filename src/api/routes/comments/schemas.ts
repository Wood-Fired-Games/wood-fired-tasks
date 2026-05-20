import { z } from 'zod';

export const CommentResponseSchema = z.object({
  id: z.number(),
  task_id: z.number(),
  author: z.string(),
  content: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

export const CommentListResponseSchema = z.array(CommentResponseSchema);

/**
 * Paginated comment list envelope. Shape: `{ data, total, limit, offset }`.
 */
export const CommentListPaginatedResponseSchema = z.object({
  data: z.array(CommentResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const CreateCommentBodySchema = z.object({
  author: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
});
