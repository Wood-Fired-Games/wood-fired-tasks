import { z } from 'zod';

export const DependencyResponseSchema = z.object({
  id: z.number(),
  task_id: z.number(),
  blocks_task_id: z.number(),
  created_at: z.string(),
});

export const DependencyListResponseSchema = z.object({
  blocks: z.array(DependencyResponseSchema),
  blocked_by: z.array(DependencyResponseSchema),
});

export const CreateDependencyBodySchema = z.object({
  blocks_task_id: z.coerce.number().int().positive(),
});
