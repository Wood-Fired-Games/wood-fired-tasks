import { z } from 'zod';
import { ErrorResponseSchema } from '../tasks/schemas.js';
import { ValueCharterSchema } from '../../../schemas/project.schema.js';

export {
  DependencyGraphTreeResponseSchema,
  DependencyGraphGraphResponseSchema,
  DependencyGraphTextResponseSchema,
  DependencyGraphResponseSchema,
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
  // WSJF (Phase 3.1): the parsed value charter rides on every project response
  // so the remote (REST + MCP proxy) path can read it back — re-interview
  // detection and post-write confirmation both depend on it. `null` when the
  // project has no charter. Optional so legacy callers / partial rows that omit
  // the column do not fail response serialization.
  value_charter: ValueCharterSchema.nullable().optional(),
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
