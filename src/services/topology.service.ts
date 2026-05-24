import type {
  IDependencyRepository,
  ITaskRepository,
} from '../repositories/interfaces.js';
import { MAX_PAGE_LIMIT } from '../types/task.js';
import type { TopologyReport } from '../schemas/topology.schema.js';
import { CycleDetector } from '../utils/cycle-detector.js';

/**
 * Wave 4.1 (task #318) — TopologyService.
 *
 * Classifies a project's task graph as FLAT, DAG, or DAG_CYCLIC so an
 * automated runner can pick between `/tasks:loop` (parallelizable leaves) and
 * `/tasks:loop-dag` (wave-by-wave parallel dispatch respecting dependency
 * edges; Wave 4.3 / task #341), and refuse to loop when a cycle is
 * present.
 *
 * Graph definition (per AC for #318):
 *   - NODES   = every `tasks` row whose `project_id` matches the requested
 *               project. `parent_task_id` is informational — child rows are
 *               nodes too — but parent/child taxonomy IS NOT an edge.
 *   - EDGES   = every `task_dependencies` row `(task_id, blocks_task_id)` where
 *               BOTH ends point at tasks belonging to the project. Cross-
 *               project edges are dropped defensively (they would still
 *               classify the project as DAG even though the blocker lives
 *               elsewhere, which is misleading for a per-project advisory).
 *               Each row becomes `{from: task_id, to: blocks_task_id}` — i.e.
 *               `from` must finish before `to` can start.
 *   - ROOTS   = nodes with in-degree zero in the project subgraph (no task
 *               blocks them).
 *   - LEAVES  = nodes with out-degree zero (they block nothing).
 *
 * Classification rules:
 *   - 0 edges                → FLAT,        advisory `/tasks:loop`
 *   - ≥1 edge, acyclic       → DAG,         advisory `/tasks:loop-dag`
 *   - ≥1 edge, contains cycle → DAG_CYCLIC,  advisory `BLOCKED`
 *
 * FLAT special case: every task is both a root AND a leaf (in-degree 0,
 * out-degree 0). Both arrays therefore contain every node ID.
 *
 * DAG_CYCLIC special case: roots/leaves are computed from the same in/out
 * degree tables, so nodes that participate in a cycle have non-zero degree
 * on both sides and contribute to NEITHER array. When the cycle covers the
 * whole graph, both arrays may be empty.
 *
 * Defensive behaviour for orphaned edges:
 *   When a `task_dependencies` row references a task that does NOT belong
 *   to the requested project (cross-project edge OR dangling row left behind
 *   by a deleted task), the edge is DROPPED from the classifier output
 *   rather than surfacing it as an error. Rationale: the advisory is a
 *   best-effort hint and must not crash on data drift; the orphaned-edge
 *   path is exercised in the service unit tests.
 *
 * Output is deterministic: edges are sorted by `(from asc, to asc)`; roots
 * and leaves are sorted ascending. This makes downstream consumers (CI
 * gates, snapshot tests, GSD plan reviews) able to diff two runs cleanly.
 */
export class TopologyService {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly dependencyRepo: IDependencyRepository,
  ) {}

  /**
   * Classify the dependency topology of a project.
   *
   * @param projectId — required, positive integer. Empty projects (no tasks)
   *   classify as FLAT (vacuously).
   * @returns A `TopologyReport` describing the topology, edge set, roots,
   *   leaves, and the recommended runner advisory.
   */
  classify(projectId: number): TopologyReport {
    // Page through every task in the project. `findByFilters` clamps at
    // MAX_PAGE_LIMIT (500) per call, so we loop until we run out — this
    // keeps the classifier correct for large projects without forcing the
    // repository to grow an unbounded API. count() gives us an upper bound
    // so we know when to stop without a separate "no more rows" sentinel.
    const expectedTotal = this.taskRepo.count({ project_id: projectId });
    const projectTaskIds = new Set<number>();
    let offset = 0;
    while (projectTaskIds.size < expectedTotal) {
      const page = this.taskRepo.findByFilters({
        project_id: projectId,
        limit: MAX_PAGE_LIMIT,
        offset,
      });
      if (page.length === 0) break; // safety: avoid infinite loop on count drift
      for (const t of page) projectTaskIds.add(t.id);
      offset += page.length;
    }

    // All dependency rows in the system. The repository has no project-
    // scoped accessor — filtering happens in-memory against the node set
    // built above, which also drops cross-project / dangling edges.
    const allDeps = this.dependencyRepo.findAll();
    const projectEdges: Array<{ from: number; to: number }> = [];
    for (const dep of allDeps) {
      if (
        projectTaskIds.has(dep.task_id) &&
        projectTaskIds.has(dep.blocks_task_id)
      ) {
        projectEdges.push({ from: dep.task_id, to: dep.blocks_task_id });
      }
    }

    // FLAT path — zero edges in the project subgraph. Every node is both a
    // root and a leaf; emit the same sorted list in both arrays.
    if (projectEdges.length === 0) {
      const allNodes = [...projectTaskIds].sort((a, b) => a - b);
      return {
        topology: 'FLAT',
        edges: [],
        roots: allNodes,
        leaves: allNodes,
        advisory: '/tasks:loop',
      };
    }

    // Build in/out degree tables over the project subgraph so we can derive
    // roots (in-degree 0) and leaves (out-degree 0) in one pass.
    const inDegree = new Map<number, number>();
    const outDegree = new Map<number, number>();
    for (const id of projectTaskIds) {
      inDegree.set(id, 0);
      outDegree.set(id, 0);
    }
    for (const e of projectEdges) {
      outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }

    // Cycle detection — reuse the existing CycleDetector utility. Its only
    // public predicate is `wouldCreateCycle(from, to)`, but a graph is cyclic
    // iff at least one of its existing edges already participates in a back-
    // edge. We exploit this: build the detector over (edges minus one), then
    // ask whether re-adding that one edge would close a cycle. If yes, the
    // original graph was cyclic. We try each edge in turn so we don't miss a
    // cycle that doesn't touch the first edge — short-circuit on the first
    // positive answer. For acyclic graphs this stays linear in edge count;
    // for cyclic graphs we find the answer as soon as we probe an edge on
    // the cycle.
    let hasCycle = false;
    for (let i = 0; i < projectEdges.length; i++) {
      const held = projectEdges[i];
      const rest = [...projectEdges.slice(0, i), ...projectEdges.slice(i + 1)];
      const detector = new CycleDetector(
        rest.map((e) => ({ task_id: e.from, blocks_task_id: e.to })),
      );
      if (detector.wouldCreateCycle(held.from, held.to)) {
        hasCycle = true;
        break;
      }
    }

    const sortedEdges = [...projectEdges].sort(
      (a, b) => a.from - b.from || a.to - b.to,
    );

    const roots: number[] = [];
    const leaves: number[] = [];
    for (const id of [...projectTaskIds].sort((a, b) => a - b)) {
      if ((inDegree.get(id) ?? 0) === 0) roots.push(id);
      if ((outDegree.get(id) ?? 0) === 0) leaves.push(id);
    }

    if (hasCycle) {
      return {
        topology: 'DAG_CYCLIC',
        edges: sortedEdges,
        roots,
        leaves,
        advisory: 'BLOCKED',
      };
    }

    return {
      topology: 'DAG',
      edges: sortedEdges,
      roots,
      leaves,
      advisory: '/tasks:loop-dag',
    };
  }
}
