import { z } from 'zod';
import { ErrorResponseSchema } from '../tasks/schemas.js';

/**
 * ProjectResponseSchema - Zod schema for project response
 */
export const ProjectResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ProjectListResponseSchema = z.array(ProjectResponseSchema);

// Re-export ErrorResponseSchema for convenience
export { ErrorResponseSchema };
