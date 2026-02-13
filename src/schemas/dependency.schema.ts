import { z } from 'zod';

/**
 * CreateDependencySchema - validation for creating new task dependencies
 */
export const CreateDependencySchema = z
  .object({
    task_id: z.number().int().positive('Task ID must be a positive integer'),
    blocks_task_id: z
      .number()
      .int()
      .positive('Blocks task ID must be a positive integer'),
  })
  .refine((data) => data.task_id !== data.blocks_task_id, {
    message: 'A task cannot depend on itself',
  });

export type CreateDependencyInput = z.infer<typeof CreateDependencySchema>;
