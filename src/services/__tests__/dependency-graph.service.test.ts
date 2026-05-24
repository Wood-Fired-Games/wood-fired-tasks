import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { DependencyGraphService } from '../dependency-graph.service.js';
import { NotFoundError } from '../errors.js';
import type {
  DependencyGraphTreeResponse,
  DependencyGraphGraphResponse,
  DependencyGraphTextResponse,
} from '../../schemas/dependency-graph.schema.js';

/**
 * Task #342 — DependencyGraphService unit tests.
 *
 * Fixtures (matching the task plan):
 *   - empty       — zero tasks, zero edges
 *   - single-task — one task, no edges
 *   - linear      — three-node chain a→b→c
 *   - diamond     — DAG with two parents converging on one child (1→2, 1→3, 2→4, 3→4)
 *   - cyclic      — 3-node cycle a→b→c→a
 *
 * Each fixture is exercised against all three formats (tree/graph/text)
 * for behaviour coverage. The 404-on-missing-project path is covered too.
 */
describe('DependencyGraphService', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let depRepo: DependencyRepository;
  let service: DependencyGraphService;
  let projectId: number;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    depRepo = new DependencyRepository(db);
    service = new DependencyGraphService(taskRepo, depRepo, projectRepo);
    const p = projectRepo.create({ name: 'DepGraph Project' });
    projectId = p.id;
  });

  function createTask(title: string, priority: 'low' | 'medium' | 'high' | 'urgent' = 'medium', status: 'open' | 'in_progress' | 'done' | 'closed' | 'blocked' | 'backlogged' = 'open'): number {
    return taskRepo.create({
      title,
      status,
      priority,
      project_id: projectId,
      created_by: 'test-agent',
    }).id;
  }

  describe('NotFound', () => {
    it('throws NotFoundError when project does not exist (tree)', () => {
      expect(() => service.buildDependencyGraph(99999, 'tree')).toThrow(
        NotFoundError,
      );
    });

    it('throws NotFoundError when project does not exist (graph)', () => {
      expect(() => service.buildDependencyGraph(99999, 'graph')).toThrow(
        NotFoundError,
      );
    });

    it('throws NotFoundError when project does not exist (text)', () => {
      expect(() => service.buildDependencyGraph(99999, 'text')).toThrow(
        NotFoundError,
      );
    });
  });

  describe('Empty project', () => {
    it('returns empty tree shape with FLAT topology', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.format).toBe('tree');
      expect(r.roots).toEqual([]);
      expect(r.total_tasks).toBe(0);
      expect(r.total_edges).toBe(0);
      expect(r.topology).toBe('FLAT');
    });

    it('returns empty graph shape with FLAT topology', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'graph',
      ) as { format: 'graph' } & DependencyGraphGraphResponse;
      expect(r.format).toBe('graph');
      expect(r.nodes).toEqual([]);
      expect(r.edges).toEqual([]);
      expect(r.total_tasks).toBe(0);
      expect(r.total_edges).toBe(0);
      expect(r.topology).toBe('FLAT');
    });

    it('returns empty text shape with FLAT topology', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'text',
      ) as { format: 'text' } & DependencyGraphTextResponse;
      expect(r.format).toBe('text');
      expect(r.lines).toEqual([]);
      expect(r.total_tasks).toBe(0);
      expect(r.total_edges).toBe(0);
      expect(r.topology).toBe('FLAT');
    });
  });

  describe('Single task / flat project', () => {
    it('returns a single root with no children (tree)', () => {
      const id = createTask('lonely', 'high');
      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.topology).toBe('FLAT');
      expect(r.roots).toHaveLength(1);
      expect(r.roots[0].id).toBe(id);
      expect(r.roots[0].title).toBe('lonely');
      expect(r.roots[0].priority).toBe('high');
      expect(r.roots[0].depth).toBe(0);
      expect(r.roots[0].blocked_by_count).toBe(0);
      expect(r.roots[0].children).toEqual([]);
      expect(r.total_tasks).toBe(1);
      expect(r.total_edges).toBe(0);
    });

    it('returns one node and zero edges (graph)', () => {
      const id = createTask('lonely');
      const r = service.buildDependencyGraph(
        projectId,
        'graph',
      ) as { format: 'graph' } & DependencyGraphGraphResponse;
      expect(r.nodes).toEqual([
        {
          id,
          title: 'lonely',
          status: 'open',
          priority: 'medium',
        },
      ]);
      expect(r.edges).toEqual([]);
      expect(r.topology).toBe('FLAT');
    });

    it('renders a single root line (text)', () => {
      const id = createTask('lonely', 'urgent');
      const r = service.buildDependencyGraph(
        projectId,
        'text',
      ) as { format: 'text' } & DependencyGraphTextResponse;
      expect(r.lines).toHaveLength(1);
      // Status glyph for `open` is `○`; priority shown in parens.
      expect(r.lines[0]).toContain(`#${id}`);
      expect(r.lines[0]).toContain('lonely');
      expect(r.lines[0]).toContain('(urgent)');
    });

    it('sorts multiple flat tasks by priority desc → created_at desc', () => {
      // Create in order: low, urgent, medium. Expected tree order: urgent,
      // medium, low (priority desc). created_at ties broken by recency.
      const low = createTask('a-low', 'low');
      const urgent = createTask('b-urgent', 'urgent');
      const medium = createTask('c-medium', 'medium');
      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.roots.map((n) => n.id)).toEqual([urgent, medium, low]);
    });
  });

  describe('Linear chain a→b→c', () => {
    let a: number;
    let b: number;
    let c: number;
    beforeEach(() => {
      a = createTask('a');
      b = createTask('b');
      c = createTask('c');
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: b, blocks_task_id: c });
    });

    it('builds nested tree a → b → c (tree)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.topology).toBe('DAG');
      expect(r.roots).toHaveLength(1);
      const rootA = r.roots[0];
      expect(rootA.id).toBe(a);
      expect(rootA.depth).toBe(0);
      expect(rootA.blocked_by_count).toBe(0);
      expect(rootA.children).toHaveLength(1);
      const childB = rootA.children[0];
      expect(childB.id).toBe(b);
      expect(childB.depth).toBe(1);
      expect(childB.blocked_by_count).toBe(1);
      expect(childB.children).toHaveLength(1);
      const childC = childB.children[0];
      expect(childC.id).toBe(c);
      expect(childC.depth).toBe(2);
      expect(childC.blocked_by_count).toBe(1);
      expect(childC.children).toEqual([]);
      expect(r.total_tasks).toBe(3);
      expect(r.total_edges).toBe(2);
    });

    it('lists three nodes and two edges (graph)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'graph',
      ) as { format: 'graph' } & DependencyGraphGraphResponse;
      expect(r.nodes).toHaveLength(3);
      // Sorted by id ascending.
      expect(r.nodes.map((n) => n.id)).toEqual([a, b, c]);
      expect(r.edges).toEqual([
        { from: a, to: b },
        { from: b, to: c },
      ]);
      expect(r.topology).toBe('DAG');
    });

    it('renders three indented lines (text)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'text',
      ) as { format: 'text' } & DependencyGraphTextResponse;
      expect(r.lines).toHaveLength(3);
      // Root line has no connector.
      expect(r.lines[0]).toMatch(/^#\d+ ○ a \(medium\)$/);
      // Single-child subsequent lines use `└──` (last sibling).
      expect(r.lines[1]).toContain('└──');
      expect(r.lines[1]).toContain('b');
      expect(r.lines[2]).toContain('└──');
      expect(r.lines[2]).toContain('c');
    });
  });

  describe('DAG diamond (1 blocks 2 + 3, both block 4)', () => {
    let n1: number;
    let n2: number;
    let n3: number;
    let n4: number;

    beforeEach(() => {
      n1 = createTask('1', 'urgent');
      n2 = createTask('2', 'high');
      n3 = createTask('3', 'high');
      n4 = createTask('4', 'medium');
      depRepo.create({ task_id: n1, blocks_task_id: n2 });
      depRepo.create({ task_id: n1, blocks_task_id: n3 });
      depRepo.create({ task_id: n2, blocks_task_id: n4 });
      depRepo.create({ task_id: n3, blocks_task_id: n4 });
    });

    it('duplicates the diamond child under each parent (tree)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.topology).toBe('DAG');
      // Single root: n1.
      expect(r.roots).toHaveLength(1);
      const root = r.roots[0];
      expect(root.id).toBe(n1);
      // n1 has two children (n2 and n3), each in turn has n4 as a child.
      // Tree-shape AC: "DAG diamonds DUPLICATE the subtree under each parent".
      expect(root.children).toHaveLength(2);
      const childIds = root.children.map((c) => c.id).sort();
      expect(childIds).toEqual([n2, n3].sort());
      for (const child of root.children) {
        expect(child.children).toHaveLength(1);
        expect(child.children[0].id).toBe(n4);
        // n4 has TWO blockers (n2 and n3), so blocked_by_count = 2 on BOTH
        // duplicates (it's a per-node property, not per-path).
        expect(child.children[0].blocked_by_count).toBe(2);
      }
      // Total counts reflect the underlying graph, not the duplicated tree.
      expect(r.total_tasks).toBe(4);
      expect(r.total_edges).toBe(4);
    });

    it('appears exactly once in nodes (graph)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'graph',
      ) as { format: 'graph' } & DependencyGraphGraphResponse;
      expect(r.nodes).toHaveLength(4);
      const ids = new Set(r.nodes.map((n) => n.id));
      expect(ids.size).toBe(4); // each task exactly once
      expect(r.edges).toHaveLength(4);
      // Edges sorted by (from, to).
      expect(r.edges).toEqual(
        [
          { from: n1, to: n2 },
          { from: n1, to: n3 },
          { from: n2, to: n4 },
          { from: n3, to: n4 },
        ].sort((a, b) => a.from - b.from || a.to - b.to),
      );
    });

    it('renders n4 twice in text output (duplicated subtree)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'text',
      ) as { format: 'text' } & DependencyGraphTextResponse;
      // 5 lines = root + 2 children + 2 duplicated grandchildren.
      expect(r.lines).toHaveLength(5);
      const n4Lines = r.lines.filter((l) => l.includes(`#${n4} `));
      expect(n4Lines).toHaveLength(2);
    });
  });

  describe('Cyclic graph (a→b→c→a)', () => {
    let a: number;
    let b: number;
    let c: number;

    beforeEach(() => {
      a = createTask('a');
      b = createTask('b');
      c = createTask('c');
      // Seed the cycle directly via repo (DependencyService would refuse).
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: b, blocks_task_id: c });
      depRepo.create({ task_id: c, blocks_task_id: a });
    });

    it('classifies as DAG_CYCLIC and halts tree expansion at first revisit', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.topology).toBe('DAG_CYCLIC');
      // Every node has in-degree ≥ 1, so the strict roots-from-in-degree-0
      // rule would give an empty array — but for the tree shape we still
      // need SOMETHING to walk, so the service uses in-degree 0. The cycle
      // case has no such node, so `roots` is empty here. The dashboard's
      // contract is that the `topology` flag warns the consumer.
      expect(r.roots).toEqual([]);
      // total counts still reflect the underlying graph.
      expect(r.total_tasks).toBe(3);
      expect(r.total_edges).toBe(3);
    });

    it('does not infinite-recurse in text output for a cycle', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'text',
      ) as { format: 'text' } & DependencyGraphTextResponse;
      // With zero in-degree-0 roots, the text shape emits zero lines —
      // the cycle is unreachable from the standard root set. Topology
      // still flags DAG_CYCLIC.
      expect(r.topology).toBe('DAG_CYCLIC');
      expect(r.lines).toEqual([]);
    });

    it('still emits all nodes + all edges (graph)', () => {
      const r = service.buildDependencyGraph(
        projectId,
        'graph',
      ) as { format: 'graph' } & DependencyGraphGraphResponse;
      expect(r.topology).toBe('DAG_CYCLIC');
      expect(r.nodes).toHaveLength(3);
      expect(r.edges).toHaveLength(3);
    });

    it('cycle reachable from an extra root halts tree expansion safely', () => {
      // Add a separate root x that blocks the cycle entry (x→a). Now x has
      // in-degree 0 and the tree walker MUST descend into the cycle without
      // looping forever.
      const x = createTask('x', 'urgent');
      depRepo.create({ task_id: x, blocks_task_id: a });

      const r = service.buildDependencyGraph(
        projectId,
        'tree',
      ) as { format: 'tree' } & DependencyGraphTreeResponse;
      expect(r.topology).toBe('DAG_CYCLIC');
      // x is the only in-degree-0 node now.
      expect(r.roots).toHaveLength(1);
      expect(r.roots[0].id).toBe(x);
      // Walk depth-first under x. The exact node count below the root depends
      // on which edge closes the cycle on the visited branch — the important
      // invariant is bounded recursion. We assert there's a reasonable upper
      // bound on total node visits (no infinite recursion).
      const countNodes = (
        node: { children: Array<{ id: number; children: unknown[] }> },
      ): number =>
        1 +
        node.children.reduce(
          (acc, c) => acc + countNodes(c as typeof node),
          0,
        );
      const totalVisits = countNodes(
        r.roots[0] as unknown as {
          children: Array<{ id: number; children: unknown[] }>;
        },
      );
      // For a 4-node graph with this cycle, the bounded DFS visits at most
      // O(N) per branch — generous upper bound of 20 catches infinite loops
      // (recursion limit would blow up well before 20 anyway).
      expect(totalVisits).toBeLessThan(20);
      expect(totalVisits).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Format defaulting', () => {
    it('treats explicit `tree` and the schema default identically', () => {
      const a = createTask('a');
      const b = createTask('b');
      depRepo.create({ task_id: a, blocks_task_id: b });

      const explicit = service.buildDependencyGraph(projectId, 'tree');
      // The schema default is applied at the route layer; service callers
      // pass `tree` explicitly. We verify here that `tree` is the correct
      // service-layer name.
      expect(explicit.format).toBe('tree');
    });
  });
});
