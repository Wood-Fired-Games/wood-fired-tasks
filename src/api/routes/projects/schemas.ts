import { z } from 'zod';
import { ErrorResponseSchema } from '../tasks/schemas.js';

export {
  DependencyGraphTreeResponseSchema,
  DependencyGraphGraphResponseSchema,
  DependencyGraphTextResponseSchema,
  DependencyGraphFormatSchema,
} from '../../../schemas/dependency-graph.schema.js';

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

/**
 * Paginated project list envelope returned by GET /projects.
 * Shape: `{ data: ProjectResponse[], total, limit, offset }`.
 */
export const ProjectListPaginatedResponseSchema = z.object({
  data: z.array(ProjectResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

// Re-export ErrorResponseSchema for convenience
export { ErrorResponseSchema };
