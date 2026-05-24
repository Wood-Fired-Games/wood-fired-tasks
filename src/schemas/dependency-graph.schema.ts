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
 *
 * Cyclic-only projects (every task has incoming edges → no in-degree-0
 * root): the service picks a single synthetic root using the same
 * priority-desc / created_at-desc / id-asc ordering and walks from there.
 * The per-branch visited-set still bounds recursion. `topology` stays
 * `DAG_CYCLIC` so consumers can still flag the result.
 *
 * Tree expansion is bounded by `MAX_TREE_NODES` to prevent DoS via deep
 * DAG diamonds (K stacked diamonds → 2^K leaves). When the cap is hit,
 * `truncated: true` is set on `format=tree` and `format=text` responses.
 * `format=graph` is inherently flat — `truncated` is always `false` there.
 *
 * Schema layout (N5): every variant carries a `format` literal as the
 * first field so the response is expressible as a `z.discriminatedUnion`.
 * Both the individual variant schemas AND the union are exported; route
 * code uses the union directly without `.extend({ format: ... })` ceremony.
 */

/** Hard cap on total nodes emitted by `format=tree` / `format=text`. */
export const MAX_TREE_NODES = 1000;

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
  format: z.literal('tree'),
  roots: z.array(DependencyGraphTreeNodeSchema),
  total_tasks: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
  topology: z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']),
  /** True iff tree expansion hit MAX_TREE_NODES and stopped early. */
  truncated: z.boolean(),
});
export type DependencyGraphTreeResponse = z.infer<
  typeof DependencyGraphTreeResponseSchema
>;

/** `format=graph` response. Each task appears exactly once. */
export const DependencyGraphGraphResponseSchema = z.object({
  format: z.literal('graph'),
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
  format: z.literal('text'),
  lines: z.array(z.string()),
  topology: z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']),
  total_tasks: z.number().int().nonnegative(),
  total_edges: z.number().int().nonnegative(),
  /** True iff tree expansion hit MAX_TREE_NODES and stopped early. */
  truncated: z.boolean(),
});
export type DependencyGraphTextResponse = z.infer<
  typeof DependencyGraphTextResponseSchema
>;

/**
 * Discriminated union of all three shapes. The `format` literal on each
 * variant lets zod (and OpenAPI consumers) narrow the response without
 * peeking at the other fields.
 */
export const DependencyGraphResponseSchema = z.discriminatedUnion('format', [
  DependencyGraphTreeResponseSchema,
  DependencyGraphGraphResponseSchema,
  DependencyGraphTextResponseSchema,
]);
export type DependencyGraphResult = z.infer<
  typeof DependencyGraphResponseSchema
>;

/** Format query parameter. Defaults to `tree`. */
export const DependencyGraphFormatSchema = z
  .enum(['tree', 'graph', 'text'])
  .default('tree');
export type DependencyGraphFormat = z.infer<typeof DependencyGraphFormatSchema>;
