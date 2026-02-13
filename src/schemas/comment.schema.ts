import { z } from 'zod';

export const CreateCommentSchema = z.object({
  task_id: z.number().int().positive(),
  author: z.string().min(1).max(100),
  content: z.string().min(1).max(5000),
});

export const CommentResponseSchema = z.object({
  id: z.number(),
  task_id: z.number(),
  author: z.string(),
  content: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
