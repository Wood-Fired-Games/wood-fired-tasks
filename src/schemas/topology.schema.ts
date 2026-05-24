import { z } from 'zod';

/**
 * Wave 4.1 (task #318) — Task-topology classifier output contract.
 *
 * `TopologyReportSchema` is the wire-shape returned by:
 *   - `TopologyService.classify(projectId)`
 *   - the `tasks topology --project <id>` CLI command (stdout JSON)
 *   - the `topology_check` MCP tool (structuredContent)
 *
 * The classifier decides whether a project is `/tasks:loop`-safe (parallelizable
 * leaves) or requires `/tasks:loop-dag` (wave-by-wave parallel dispatch
 * respecting dependency edges; Wave 4.3 / task #341) based on whether the
 * project's `task_dependencies` rows form a flat set, an acyclic DAG, or a
 * cycle-bearing graph.
 *
 * Field semantics:
 *   - `topology`:
 *       FLAT        — zero `task_dependencies` edges in the project.
 *       DAG         — ≥1 edge, no cycles (a total order exists).
 *       DAG_CYCLIC  — ≥1 edge, contains a cycle (`/tasks:loop` is unsafe).
 *   - `edges`: `{from, to}` rows where `from` blocks `to` (i.e. `from` must
 *     complete before `to` can start). Derived from `task_dependencies`
 *     (`task_id → blocks_task_id`). Sorted by (from asc, to asc) for
 *     deterministic comparison across runs.
 *   - `roots`: task IDs with zero in-degree (no task blocks them). Sorted asc.
 *   - `leaves`: task IDs with zero out-degree (they block nothing). Sorted asc.
 *   - `advisory`:
 *       `/tasks:loop`        — recommended for FLAT projects.
 *       `/tasks:loop-dag`    — recommended for DAG projects (Wave 4.3 / #341).
 *       `BLOCKED`            — refuse to loop; manual intervention needed for
 *                              DAG_CYCLIC projects.
 *
 * NOTE: `parent_task_id` (the taxonomy column) is INCLUDED in node enumeration
 * (we know about parent/child rows) but NOT counted as graph edges — per AC
 * "excluding parent/child taxonomy edges". The only edge source is the
 * `task_dependencies` table.
 */
export const TopologyReportSchema = z.object({
  topology: z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']),
  edges: z.array(
    z.object({
      from: z.number().int().positive(),
      to: z.number().int().positive(),
    }),
  ),
  roots: z.array(z.number().int().positive()),
  leaves: z.array(z.number().int().positive()),
  advisory: z.enum(['/tasks:loop', '/tasks:loop-dag', 'BLOCKED']),
});

export type TopologyReport = z.infer<typeof TopologyReportSchema>;
