import { z } from 'zod';
import { TASK_STATUSES, TASK_PRIORITIES } from '../types/task.js';

/**
 * Task #342 — Dependency-graph endpoint schemas.
 *
 * Three output shapes for the Agent Overview dashboard's tree-view panel:
 *   - `tree`  — file-tree mental model. DAG diamonds (a task with ≥2 parents)
 *               are DUPLICATED under each parent so the dashboard can render
 *               them as repeated rows. Each duplicate keeps the same `id` so
 *               the panel can dedupe visually.
 *   - `graph` — flat node+edge list. Each task appears exactly once. Intended
 *               for Grafana's native Node Graph panel.
 *   - `text`  — pre-rendered box-drawing lines (├── └── │). Status glyphs:
 *               ○ open, ◐ in_progress, ✓ done, ✗ blocked.
 *
 * Cycle handling: format=tree and format=text both halt at first revisit
 * per branch (per-branch visited-set tracking). The response carries the
 * `topology` flag (FLAT | DAG | DAG_CYCLIC) so the consumer can warn.
 */

/**
 * Tree node schema is recursive. `z.ZodTypeAny` is the documented escape
 * hatch the zod README uses for self-referential schemas — we narrow back
 * via `z.lazy()` so the recursive `children` field is typed.
 */
export interface DependencyGraphTreeNode {
  id: number;
  title: string;
  status: (typeof TASK_STATUSES)[number];
  priority: (typeof TASK_PRIORITIES)[number];
  depth: number;
  blocked_by_count: number;
  children: DependencyGraphTreeNode[];
}

export const DependencyGraphTreeNodeSchema: z.ZodType<DependencyGraphTreeNode> =
  z.lazy(() =>
    z.object({
      id: z.number().int().positive(),
      title: z.string(),
      status: z.enum(TASK_STATUSES),
      priority: z.enum(TASK_PRIORITIES),
      depth: z.number().int().nonnegative(),
      blocked_by_count: z.number().int().nonnegative(),
      children: z.array(DependencyGraphTreeNodeSchema),
    }),
  );

/** `format=tree` response. */
export const DependencyGraphTreeResponseSchema = z.object({
  roots: z.array(DependencyGraphTreeNodeSchema),
  total_tasks: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
  topology: z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']),
});
export type DependencyGraphTreeResponse = z.infer<
  typeof DependencyGraphTreeResponseSchema
>;

/** `format=graph` response. Each task appears exactly once. */
export const DependencyGraphGraphResponseSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.number().int().positive(),
      title: z.string(),
      status: z.enum(TASK_STATUSES),
      priority: z.enum(TASK_PRIORITIES),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.number().int().positive(),
      to: z.number().int().positive(),
    }),
  ),
  topology: z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']),
  total_tasks: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
});
export type DependencyGraphGraphResponse = z.infer<
  typeof DependencyGraphGraphResponseSchema
>;

/** `format=text` response — pre-rendered box-drawing lines. */
export const DependencyGraphTextResponseSchema = z.object({
  lines: z.array(z.string()),
  topology: z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']),
  total_tasks: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
});
export type DependencyGraphTextResponse = z.infer<
  typeof DependencyGraphTextResponseSchema
>;

/** Union of all three shapes — returned by the service layer. */
export type DependencyGraphResult =
  | ({ format: 'tree' } & DependencyGraphTreeResponse)
  | ({ format: 'graph' } & DependencyGraphGraphResponse)
  | ({ format: 'text' } & DependencyGraphTextResponse);

/** Format query parameter. Defaults to `tree`. */
export const DependencyGraphFormatSchema = z
  .enum(['tree', 'graph', 'text'])
  .default('tree');
export type DependencyGraphFormat = z.infer<typeof DependencyGraphFormatSchema>;
