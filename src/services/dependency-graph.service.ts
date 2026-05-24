import type {
  IDependencyRepository,
  ITaskRepository,
  IProjectRepository,
} from '../repositories/interfaces.js';
import { MAX_PAGE_LIMIT } from '../types/task.js';
import type { Task, TaskPriority, TaskStatus } from '../types/task.js';
import { NotFoundError } from './errors.js';
import { TopologyService } from './topology.service.js';
import type {
  DependencyGraphFormat,
  DependencyGraphResult,
  DependencyGraphTreeNode,
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
 * Topology classification (`FLAT`/`DAG`/`DAG_CYCLIC`) is delegated to
 * `TopologyService` — same bulk-read pattern, same cycle detector — so we
 * don't fork the classifier.
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
 *   - `format=graph` is intrinsically cycle-safe (flat node+edge list).
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

export class DependencyGraphService {
  private readonly topologyService: TopologyService;

  constructor(
    private readonly taskRepo: ITaskRepository,
    private readonly dependencyRepo: IDependencyRepository,
    private readonly projectRepo: IProjectRepository,
  ) {
    this.topologyService = new TopologyService(taskRepo, dependencyRepo);
  }

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

    // ── Single bulk pass: load every task in the project. Loop through
    // pages because `findByFilters` clamps at MAX_PAGE_LIMIT (500). For
    // most dashboards N << 500 and this is one statement; the loop is
    // there to stay correct for large projects without an O(N) API hack.
    const expectedTotal = this.taskRepo.count({ project_id: projectId });
    const tasks: Array<Task & { tags: string[] }> = [];
    let offset = 0;
    while (tasks.length < expectedTotal) {
      const page = this.taskRepo.findByFilters({
        project_id: projectId,
        limit: MAX_PAGE_LIMIT,
        offset,
      });
      if (page.length === 0) break; // safety: avoid infinite loop on count drift
      tasks.push(...page);
      offset += page.length;
    }

    // ── Single bulk pass: load every dependency row, filter to in-project.
    const tasksById = new Map<number, Task & { tags: string[] }>();
    for (const t of tasks) tasksById.set(t.id, t);

    const allDeps = this.dependencyRepo.findAll();
    const projectEdges: Array<{ from: number; to: number }> = [];
    for (const dep of allDeps) {
      if (tasksById.has(dep.task_id) && tasksById.has(dep.blocks_task_id)) {
        projectEdges.push({ from: dep.task_id, to: dep.blocks_task_id });
      }
    }

    // Reuse TopologyService for cycle detection / FLAT/DAG/DAG_CYCLIC label.
    // It re-reads the same data (one tasks query, one deps query) — acceptable
    // given the data sizes in play and avoids forking cycle-detector logic.
    const topologyReport = this.topologyService.classify(projectId);
    const topology = topologyReport.topology;

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
      return {
        format: 'graph',
        nodes,
        edges,
        topology,
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

    const rootIds = tasks
      .filter((t) => (inDegree.get(t.id) ?? 0) === 0)
      .map((t) => t.id)
      .sort(compareTasks);

    if (format === 'text') {
      const lines = renderTextLines({
        rootIds,
        childrenByParent,
        tasksById,
        inDegree,
      });
      return {
        format: 'text',
        lines,
        topology,
        total_tasks: totalTasks,
        total_edges: totalEdges,
      };
    }

    // format === 'tree'
    const roots: DependencyGraphTreeNode[] = rootIds.map((id) =>
      buildTreeNode(id, 0, new Set<number>(), {
        childrenByParent,
        tasksById,
        inDegree,
      }),
    );
    return {
      format: 'tree',
      roots,
      topology,
      total_tasks: totalTasks,
      total_edges: totalEdges,
    };
  }
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
 */
function buildTreeNode(
  id: number,
  depth: number,
  visited: Set<number>,
  ctx: TreeContext,
): DependencyGraphTreeNode {
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
  const nextVisited = new Set(visited);
  nextVisited.add(id);
  const childIds = ctx.childrenByParent.get(id) ?? [];
  const children = childIds.map((childId) =>
    buildTreeNode(childId, depth + 1, nextVisited, ctx),
  );
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
 */
function renderTextLines(ctx: TextRenderContext): string[] {
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
    const task = ctx.tasksById.get(id);
    if (!task) return;
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
      const childId = childIds[i];
      const last = i === childIds.length - 1;
      walk(childId, childPrefix, last, false, nextVisited);
    }
  }

  for (const rootId of ctx.rootIds) {
    walk(rootId, '', true, true, new Set<number>());
  }
  return out;
}
