import type Database from 'better-sqlite3';
import type {
  IDependencyRepository,
  ITaskRepository,
  IProjectRepository,
} from '../repositories/interfaces.js';
import { MAX_PAGE_LIMIT } from '../types/task.js';
import type { Task, TaskPriority, TaskStatus } from '../types/task.js';
import { NotFoundError } from './errors.js';
import {
  MAX_TREE_NODES,
  type DependencyGraphFormat,
  type DependencyGraphResult,
  type DependencyGraphTreeNode,
} from '../schemas/dependency-graph.schema.js';

/**
 * Task #342 — DependencyGraphService.
 *
 * Builds the three output shapes (`tree`, `graph`, `text`) the Agent Overview
 * dashboard needs for its file-tree-style "Open Tasks" panel. Avoids the N+1
 * trap on the per-task `GET /tasks/:id/dependencies` endpoint by loading the
 * project's tasks AND its `task_dependencies` rows once each, then composing
 * the requested shape in-memory.
 *
 * Topology classification (`FLAT`/`DAG`/`DAG_CYCLIC`) is computed INLINE
 * (N3) using Kahn's algorithm against the in-degree map already built for
 * the root-detection pass — no second bulk read.
 *
 * Sort orders (deterministic):
 *   - roots / children: priority desc → created_at desc.
 *   - graph nodes: id asc.
 *   - graph edges: (from asc, to asc).
 *   - text lines: tree-order DFS over the same priority-desc tree.
 *
 * Cycle behaviour:
 *   - `format=tree` and `format=text` use per-branch visited-set tracking and
 *     halt at the first revisit, so a cycle does NOT cause infinite recursion.
 *     The `topology` field carries `DAG_CYCLIC` for downstream consumers.
 *   - Cyclic-only projects (N1): when no task has in-degree 0, we pick a
 *     SINGLE synthetic root (highest priority, newest, lowest id) and walk
 *     from there so consumers always see at least one row.
 *   - `format=graph` is intrinsically cycle-safe (flat node+edge list).
 *
 * Truncation (N2): tree expansion is capped at `MAX_TREE_NODES` total nodes
 * to bound the DoS surface from deep DAG diamonds (K stacked diamonds emit
 * 2^K leaves in the duplicated-subtree shape). When the cap is hit the
 * walker stops and the response carries `truncated: true`.
 *
 * Snapshot isolation (N6): the bulk reads (count + paginated findByFilters +
 * dependencies findAll) run inside a `db.transaction(() => {})()` so a
 * concurrent writer cannot make the count and the rows we actually retrieve
 * disagree.
 *
 * Tag hydration (N7): `findByFilters({ include_tags: false })` skips the
 * `task_tags` LEFT JOIN — the graph builder never reads the `tags` field.
 */

/** Priority sort weight — higher = listed first. */
const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Status glyphs for `format=text`. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  open: '○', // ○
  in_progress: '◐', // ◐
  done: '✓', // ✓
  closed: '✓', // ✓ — terminal state, same glyph as done
  blocked: '✗', // ✗
  backlogged: '○', // ○ — same as open in the dashboard's eyes
};

/** Lightweight mutable counter passed down the tree walk for truncation. */
interface TreeCounter {
  count: number;
  truncated: boolean;
}

export class DependencyGraphService {
  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly dependencyRepo: IDependencyRepository,
    private readonly projectRepo: IProjectRepository,
    /**
     * Optional better-sqlite3 handle. When provided, the bulk reads inside
     * `buildDependencyGraph` run inside a `db.transaction(() => {})()` for
     * snapshot isolation (N6). When omitted the reads run without an
     * enclosing transaction — used by service-layer unit tests that don't
     * want to wire `app.db` through.
     */
    private readonly db?: Database.Database,
  ) {}

  /**
   * Build the requested dependency-graph shape for a project.
   *
   * @param projectId — positive integer. Must reference an existing project.
   * @param format    — one of `tree` (default), `graph`, `text`.
   * @throws NotFoundError when the project does not exist.
   */
  buildDependencyGraph(
    projectId: number,
    format: DependencyGraphFormat,
  ): DependencyGraphResult {
    const project = this.projectRepo.findById(projectId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    // ── Snapshot-isolated bulk read (N6). Wrap the count + paged-tasks +
    // dependency lookup in a transaction so concurrent writers cannot
    // produce inconsistent pages. When no db handle is wired (unit tests),
    // we run the same body inline — the test harness uses a single-threaded
    // in-memory SQLite anyway.
    const readSnapshot = (): {
      tasks: Array<Task & { tags: string[] }>;
      projectEdges: Array<{ from: number; to: number }>;
    } => {
      // Single bulk pass: load every task in the project. Loop through
      // pages because `findByFilters` clamps at MAX_PAGE_LIMIT (500). For
      // most dashboards N << 500 and this is one statement; the loop is
      // there to stay correct for large projects without an O(N) API hack.
      // `include_tags: false` (N7) drops the task_tags LEFT JOIN — the
      // graph builder never reads the `tags` field, so the hydration cost
      // is pure waste.
      const expectedTotal = this.taskRepo.count({ project_id: projectId });
      const tasksLocal: Array<Task & { tags: string[] }> = [];
      let offset = 0;
      while (tasksLocal.length < expectedTotal) {
        const page = this.taskRepo.findByFilters({
          project_id: projectId,
          limit: MAX_PAGE_LIMIT,
          offset,
          include_tags: false,
        });
        if (page.length === 0) break; // safety: avoid infinite loop on count drift
        tasksLocal.push(...page);
        offset += page.length;
      }

      // Single bulk pass: load every dependency row, filter to in-project.
      const tasksByIdLocal = new Set<number>();
      for (const t of tasksLocal) tasksByIdLocal.add(t.id);

      const allDeps = this.dependencyRepo.findAll();
      const edges: Array<{ from: number; to: number }> = [];
      for (const dep of allDeps) {
        if (
          tasksByIdLocal.has(dep.task_id) &&
          tasksByIdLocal.has(dep.blocks_task_id)
        ) {
          edges.push({ from: dep.task_id, to: dep.blocks_task_id });
        }
      }
      return { tasks: tasksLocal, projectEdges: edges };
    };

    const { tasks, projectEdges } = this.db
      ? this.db.transaction(readSnapshot)()
      : readSnapshot();

    const tasksById = new Map<number, Task & { tags: string[] }>();
    for (const t of tasks) tasksById.set(t.id, t);

    const totalTasks = tasks.length;
    const totalEdges = projectEdges.length;

    if (format === 'graph') {
      const nodes = [...tasks]
        .sort((a, b) => a.id - b.id)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
        }));
      const edges = [...projectEdges].sort(
        (a, b) => a.from - b.from || a.to - b.to,
      );
      // Topology for the graph shape (N3): inline classifier — no second
      // bulk read. graph payload never needs tree-walking, so no truncation.
      const topologyGraph = classifyTopologyInline(tasks, projectEdges);
      return {
        format: 'graph',
        nodes,
        edges,
        topology: topologyGraph,
        total_tasks: totalTasks,
        total_edges: totalEdges,
      };
    }

    // ── Tree + text both walk the same parent→child structure. Build it
    // once. Parents are tasks that block another task (edge.from). Children
    // are the blocked tasks (edge.to). Roots are tasks with NO incoming
    // edge — i.e. they appear as a `from` but never as a `to`.
    const childrenByParent = new Map<number, number[]>();
    const inDegree = new Map<number, number>();
    for (const t of tasks) {
      childrenByParent.set(t.id, []);
      inDegree.set(t.id, 0);
    }
    for (const e of projectEdges) {
      childrenByParent.get(e.from)?.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }

    // Sort children deterministically (priority desc → created_at desc).
    const compareTasks = (
      aId: number,
      bId: number,
    ): number => {
      const a = tasksById.get(aId);
      const b = tasksById.get(bId);
      if (!a || !b) return aId - bId;
      const wa = PRIORITY_WEIGHT[a.priority];
      const wb = PRIORITY_WEIGHT[b.priority];
      if (wa !== wb) return wb - wa; // higher priority first
      // created_at desc — newer first.
      if (a.created_at !== b.created_at) {
        return a.created_at < b.created_at ? 1 : -1;
      }
      return a.id - b.id; // tiebreak deterministically
    };
    for (const arr of childrenByParent.values()) arr.sort(compareTasks);

    let rootIds = tasks
      .filter((t) => (inDegree.get(t.id) ?? 0) === 0)
      .map((t) => t.id)
      .sort(compareTasks);

    // N1 — cyclic-only projects (every task has incoming edges, so no
    // in-degree-0 root) used to return `roots: []` and an empty payload,
    // silently hiding the data. When that happens, fall back to a SINGLE
    // synthetic root chosen by the same priority-desc / created_at-desc /
    // id-asc ordering so consumers always have something to walk. The
    // per-branch visited-set already bounds the walk on the resulting
    // cycle. `topology` still reports `DAG_CYCLIC`.
    if (rootIds.length === 0 && tasks.length > 0) {
      const allIdsSorted = tasks.map((t) => t.id).sort(compareTasks);
      rootIds = [allIdsSorted[0]];
    }

    // Topology label (N3): inline classifier. Reuses the inDegree map we
    // already built so it's a Kahn's algorithm scan over `tasks`/`edges` —
    // no second tasks query, no second dependencies query.
    const topology = classifyFromInDegree(tasks, projectEdges, inDegree);

    if (format === 'text') {
      const counter: TreeCounter = { count: 0, truncated: false };
      const lines = renderTextLines(
        {
          rootIds,
          childrenByParent,
          tasksById,
          inDegree,
        },
        counter,
      );
      return {
        format: 'text',
        lines,
        topology,
        total_tasks: totalTasks,
        total_edges: totalEdges,
        truncated: counter.truncated,
      };
    }

    // format === 'tree'
    const counter: TreeCounter = { count: 0, truncated: false };
    const roots: DependencyGraphTreeNode[] = [];
    for (const id of rootIds) {
      if (counter.count >= MAX_TREE_NODES) {
        counter.truncated = true;
        break;
      }
      roots.push(
        buildTreeNode(
          id,
          0,
          new Set<number>(),
          {
            childrenByParent,
            tasksById,
            inDegree,
          },
          counter,
        ),
      );
    }
    return {
      format: 'tree',
      roots,
      topology,
      total_tasks: totalTasks,
      total_edges: totalEdges,
      truncated: counter.truncated,
    };
  }
}

/**
 * Inline Kahn's-algorithm classifier (N3). Operates over the already-loaded
 * task + edge lists so the dependency-graph endpoint doesn't make a second
 * bulk read just to label the result.
 *
 *   - FLAT       — zero edges.
 *   - DAG        — all nodes drain via in-degree-0 frontier (no cycle).
 *   - DAG_CYCLIC — at least one node never drains (cycle remnant).
 */
function classifyTopologyInline(
  tasks: ReadonlyArray<{ id: number }>,
  edges: ReadonlyArray<{ from: number; to: number }>,
): 'FLAT' | 'DAG' | 'DAG_CYCLIC' {
  if (edges.length === 0) return 'FLAT';
  const inDegree = new Map<number, number>();
  for (const t of tasks) inDegree.set(t.id, 0);
  for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  return classifyFromInDegree(tasks, edges, inDegree);
}

/**
 * Kahn's-algorithm classifier sharing a pre-built `inDegree` map with the
 * caller. The tree/text path already pays for this map to compute roots,
 * so reusing it here costs O(N + E) extra work and keeps us off the
 * TopologyService bulk-read path entirely.
 */
function classifyFromInDegree(
  tasks: ReadonlyArray<{ id: number }>,
  edges: ReadonlyArray<{ from: number; to: number }>,
  inDegreeIn: ReadonlyMap<number, number>,
): 'FLAT' | 'DAG' | 'DAG_CYCLIC' {
  if (edges.length === 0) return 'FLAT';
  // Adjacency for Kahn drain. We can't drain the caller's inDegree without
  // copying it — do so cheaply.
  const adj = new Map<number, number[]>();
  for (const t of tasks) adj.set(t.id, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const inDegree = new Map(inDegreeIn);
  const frontier: number[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) frontier.push(id);
  let drained = 0;
  while (frontier.length > 0) {
    const id = frontier.pop() as number;
    drained++;
    for (const nxt of adj.get(id) ?? []) {
      const left = (inDegree.get(nxt) ?? 0) - 1;
      inDegree.set(nxt, left);
      if (left === 0) frontier.push(nxt);
    }
  }
  return drained === tasks.length ? 'DAG' : 'DAG_CYCLIC';
}

interface TreeContext {
  childrenByParent: Map<number, number[]>;
  tasksById: Map<number, Task & { tags: string[] }>;
  inDegree: Map<number, number>;
}

/**
 * Recursively build a `DependencyGraphTreeNode`.
 *
 * `visited` is a per-branch set: when we descend into a child, we add the
 * parent to a NEW set we pass down. If we ever see a node twice on the same
 * root→leaf path, we stop expanding it (cycle defence). DAG diamonds — where
 * the same node is reachable via two disjoint paths from the root — are
 * NOT detected here; that's by design (duplication is the spec for tree
 * shape). Only same-branch revisits halt recursion.
 *
 * `counter` (N2) is a shared mutable struct threaded through the entire
 * walk. Every node emitted (including duplicates) bumps `count`; when the
 * cap is reached we mark `truncated=true` and stop descending. The current
 * node is still emitted with empty children so the consumer sees a clean
 * cut-off rather than a half-populated subtree.
 */
function buildTreeNode(
  id: number,
  depth: number,
  visited: Set<number>,
  ctx: TreeContext,
  counter: TreeCounter,
): DependencyGraphTreeNode {
  counter.count++;
  const task = ctx.tasksById.get(id);
  // Defensive: if a child references a task we don't have (shouldn't happen
  // — we filtered edges through tasksById earlier), return a stub.
  if (!task) {
    return {
      id,
      title: `[missing task #${id}]`,
      status: 'open',
      priority: 'low',
      depth,
      blocked_by_count: 0,
      children: [],
    };
  }
  const blockedByCount = ctx.inDegree.get(id) ?? 0;
  // Halt at first revisit per branch — cycle defence.
  if (visited.has(id)) {
    return {
      id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      depth,
      blocked_by_count: blockedByCount,
      children: [],
    };
  }
  // Truncation cap (N2). If we're already at the cap, emit this node with
  // empty children — the count has already been incremented above.
  if (counter.count >= MAX_TREE_NODES) {
    counter.truncated = true;
    return {
      id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      depth,
      blocked_by_count: blockedByCount,
      children: [],
    };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(id);
  const childIds = ctx.childrenByParent.get(id) ?? [];
  const children: DependencyGraphTreeNode[] = [];
  for (const childId of childIds) {
    if (counter.count >= MAX_TREE_NODES) {
      counter.truncated = true;
      break;
    }
    children.push(buildTreeNode(childId, depth + 1, nextVisited, ctx, counter));
  }
  return {
    id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    depth,
    blocked_by_count: blockedByCount,
    children,
  };
}

interface TextRenderContext {
  rootIds: number[];
  childrenByParent: Map<number, number[]>;
  tasksById: Map<number, Task & { tags: string[] }>;
  inDegree: Map<number, number>;
}

/**
 * Render the tree to box-drawing lines. Cycle defence mirrors `buildTreeNode`:
 * per-branch visited set, halt at first revisit (no infinite recursion).
 * Truncation (N2): shares the same MAX_TREE_NODES cap via the `counter`
 * argument — each emitted line counts as one node.
 */
function renderTextLines(
  ctx: TextRenderContext,
  counter: TreeCounter,
): string[] {
  const out: string[] = [];

  /**
   * `prefix` accumulates the box-drawing trunk for this node's depth.
   * `isLast` controls whether the connector is `└──` (last sibling) or
   * `├──` (still siblings to come).
   */
  function walk(
    id: number,
    prefix: string,
    isLastSibling: boolean,
    isRoot: boolean,
    visited: Set<number>,
  ): void {
    if (counter.count >= MAX_TREE_NODES) {
      counter.truncated = true;
      return;
    }
    const task = ctx.tasksById.get(id);
    if (!task) return;
    counter.count++;
    const glyph = STATUS_GLYPH[task.status];
    let line: string;
    if (isRoot) {
      // Root rows are printed bare — no connector. Matches the AC sample
      // (`#334 ○ CLI silent via symlink (urgent)`).
      line = `#${id} ${glyph} ${task.title} (${task.priority})`;
    } else {
      const connector = isLastSibling ? '└──' : '├──'; // └── / ├──
      line = `${prefix}${connector} #${id} ${glyph} ${task.title} (${task.priority})`;
    }
    out.push(line);

    if (visited.has(id)) return; // halt — cycle revisit
    const nextVisited = new Set(visited);
    nextVisited.add(id);
    const childIds = ctx.childrenByParent.get(id) ?? [];
    // Child prefix:
    //  - root: starts blank, child prefix is "" (children sit just under the root).
    //  - non-root: previous prefix + ("    " if last sibling else "│   ").
    const childPrefix = isRoot
      ? ''
      : prefix + (isLastSibling ? '    ' : '│   '); // "│   "
    for (let i = 0; i < childIds.length; i++) {
      if (counter.count >= MAX_TREE_NODES) {
        counter.truncated = true;
        break;
      }
      const childId = childIds[i];
      const last = i === childIds.length - 1;
      walk(childId, childPrefix, last, false, nextVisited);
    }
  }

  for (const rootId of ctx.rootIds) {
    if (counter.count >= MAX_TREE_NODES) {
      counter.truncated = true;
      break;
    }
    walk(rootId, '', true, true, new Set<number>());
  }
  return out;
}
