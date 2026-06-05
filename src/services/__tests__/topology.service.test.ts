import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { TopologyService } from '../topology.service.js';

/**
 * Wave 4.1 (task #318) — TopologyService unit tests.
 *
 * Notes on verification strategy (per orchestrator decision #7):
 *   - Each scenario builds REAL repositories against a fresh in-memory SQLite
 *     so the classifier exercises the same `findByFilters` + `findAll` paths
 *     it uses in production.
 *   - The "Project 11 / 12 shape" check seeds 9 and 15 flat tasks (matching
 *     the live numbers at the time of writing) without contacting the prod
 *     DB. Operational smoke-test against the live database is a manual step
 *     (see the task plan).
 *   - The synthetic auth-like diamond and the 3-node cycle exercise the
 *     two DAG branches.
 */
describe('TopologyService', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let depRepo: DependencyRepository;
  let service: TopologyService;
  let projectId: number;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    depRepo = new DependencyRepository(db);
    service = new TopologyService(taskRepo, depRepo);
    const p = projectRepo.create({ name: 'Topology Project' });
    projectId = p.id;
  });

  function createTask(title: string): number {
    return taskRepo.create({
      title,
      status: 'open',
      priority: 'medium',
      project_id: projectId,
      created_by: 'test-agent',
    }).id;
  }

  describe('FLAT topology', () => {
    it('classifies an empty project as FLAT with empty arrays', () => {
      const report = service.classify(projectId);
      expect(report.topology).toBe('FLAT');
      expect(report.advisory).toBe('/tasks:loop');
      expect(report.edges).toEqual([]);
      expect(report.roots).toEqual([]);
      expect(report.leaves).toEqual([]);
    });

    it('classifies N independent tasks (0 edges) as FLAT', () => {
      const ids = [createTask('a'), createTask('b'), createTask('c')];
      const report = service.classify(projectId);
      expect(report.topology).toBe('FLAT');
      expect(report.advisory).toBe('/tasks:loop');
      expect(report.edges).toEqual([]);
      // Every task is both a root and a leaf in a 0-edge graph.
      expect(report.roots).toEqual(ids.slice().sort((a, b) => a - b));
      expect(report.leaves).toEqual(ids.slice().sort((a, b) => a - b));
    });

    it('mirrors Project 11 shape: 9 flat tasks → FLAT, advisory /tasks:loop', () => {
      const ids: number[] = [];
      for (let i = 0; i < 9; i++) ids.push(createTask(`p11-t${i}`));
      const report = service.classify(projectId);
      expect(report.topology).toBe('FLAT');
      expect(report.advisory).toBe('/tasks:loop');
      expect(report.edges).toEqual([]);
      expect(report.roots).toHaveLength(9);
      expect(report.leaves).toHaveLength(9);
    });

    it('mirrors Project 12 shape: 15 flat tasks → FLAT, advisory /tasks:loop', () => {
      for (let i = 0; i < 15; i++) createTask(`p12-t${i}`);
      const report = service.classify(projectId);
      expect(report.topology).toBe('FLAT');
      expect(report.advisory).toBe('/tasks:loop');
      expect(report.roots).toHaveLength(15);
      expect(report.leaves).toHaveLength(15);
    });
  });

  describe('DAG topology', () => {
    it('classifies a single 2-node 1-edge graph as DAG', () => {
      const a = createTask('a');
      const b = createTask('b');
      depRepo.create({ task_id: a, blocks_task_id: b });
      const report = service.classify(projectId);
      expect(report.topology).toBe('DAG');
      expect(report.advisory).toBe('/tasks:loop-dag');
      expect(report.edges).toEqual([{ from: a, to: b }]);
      expect(report.roots).toEqual([a]);
      expect(report.leaves).toEqual([b]);
    });

    it('classifies the diamond fixture 1→2, 2→3, 2→4, 3→5, 4→5 as DAG', () => {
      const ids = [
        createTask('1'),
        createTask('2'),
        createTask('3'),
        createTask('4'),
        createTask('5'),
      ];
      const [n1, n2, n3, n4, n5] = ids;
      depRepo.create({ task_id: n1, blocks_task_id: n2 });
      depRepo.create({ task_id: n2, blocks_task_id: n3 });
      depRepo.create({ task_id: n2, blocks_task_id: n4 });
      depRepo.create({ task_id: n3, blocks_task_id: n5 });
      depRepo.create({ task_id: n4, blocks_task_id: n5 });

      const report = service.classify(projectId);
      expect(report.topology).toBe('DAG');
      expect(report.advisory).toBe('/tasks:loop-dag');
      expect(report.roots).toEqual([n1]);
      expect(report.leaves).toEqual([n5]);
      // Edges sorted by (from, to)
      expect(report.edges).toEqual([
        { from: n1, to: n2 },
        { from: n2, to: n3 },
        { from: n2, to: n4 },
        { from: n3, to: n5 },
        { from: n4, to: n5 },
      ]);
    });

    it('handles multiple roots and multiple leaves in a DAG', () => {
      // Two independent chains a→b and c→d in the same project.
      const a = createTask('a');
      const b = createTask('b');
      const c = createTask('c');
      const d = createTask('d');
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: c, blocks_task_id: d });

      const report = service.classify(projectId);
      expect(report.topology).toBe('DAG');
      expect(report.roots).toEqual([a, c].sort((x, y) => x - y));
      expect(report.leaves).toEqual([b, d].sort((x, y) => x - y));
    });
  });

  describe('DAG_CYCLIC topology', () => {
    it('classifies the 3-node cycle fixture 1→2, 2→3, 3→1 as DAG_CYCLIC', () => {
      const a = createTask('a');
      const b = createTask('b');
      const c = createTask('c');
      // The DependencyRepository write itself does not cycle-check (that is
      // enforced by DependencyService); the raw repo lets us seed a hostile
      // graph that the classifier should detect.
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: b, blocks_task_id: c });
      depRepo.create({ task_id: c, blocks_task_id: a });

      const report = service.classify(projectId);
      expect(report.topology).toBe('DAG_CYCLIC');
      expect(report.advisory).toBe('BLOCKED');
      expect(report.edges).toHaveLength(3);
      // The full graph is the cycle — no node has in-degree 0 or
      // out-degree 0, so roots/leaves are empty by definition.
      expect(report.roots).toEqual([]);
      expect(report.leaves).toEqual([]);
    });

    it('detects a cycle even when it does not include the first edge', () => {
      // Acyclic prefix (a→b) plus a cycle elsewhere (c→d→e→c).
      const a = createTask('a');
      const b = createTask('b');
      const c = createTask('c');
      const d = createTask('d');
      const e = createTask('e');
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: c, blocks_task_id: d });
      depRepo.create({ task_id: d, blocks_task_id: e });
      depRepo.create({ task_id: e, blocks_task_id: c });

      const report = service.classify(projectId);
      expect(report.topology).toBe('DAG_CYCLIC');
      expect(report.advisory).toBe('BLOCKED');
    });
  });

  describe('orphaned + cross-project edges', () => {
    it('drops edges that reference a task outside the requested project', () => {
      // Two projects: requested project has tasks a,b; other project has c.
      const otherProject = projectRepo.create({ name: 'Other' });
      const a = createTask('a');
      const b = createTask('b');
      const c = taskRepo.create({
        title: 'c-other',
        status: 'open',
        priority: 'medium',
        project_id: otherProject.id,
        created_by: 'test-agent',
      }).id;
      // a→c (cross-project) and a→b (in-project).
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: a, blocks_task_id: c });

      const report = service.classify(projectId);
      // Only the in-project edge survives.
      expect(report.edges).toEqual([{ from: a, to: b }]);
      expect(report.topology).toBe('DAG');
    });
  });

  describe('output determinism', () => {
    it('sorts edges by (from asc, to asc) regardless of insertion order', () => {
      const n1 = createTask('1');
      const n2 = createTask('2');
      const n3 = createTask('3');
      const n4 = createTask('4');
      // Insert edges in deliberately scrambled order.
      depRepo.create({ task_id: n2, blocks_task_id: n4 });
      depRepo.create({ task_id: n1, blocks_task_id: n3 });
      depRepo.create({ task_id: n1, blocks_task_id: n2 });

      const report = service.classify(projectId);
      // Expected sorted: (n1,n2), (n1,n3), (n2,n4).
      expect(report.edges).toEqual([
        { from: n1, to: n2 },
        { from: n1, to: n3 },
        { from: n2, to: n4 },
      ]);
    });

    it('sorts roots and leaves ascending', () => {
      // Two-root DAG: roots {a,c}, leaves {b,d}. Create in non-ascending
      // order to verify the service re-sorts.
      const d = createTask('d'); // created first → highest id might be later
      const a = createTask('a');
      const b = createTask('b');
      const c = createTask('c');
      depRepo.create({ task_id: a, blocks_task_id: b });
      depRepo.create({ task_id: c, blocks_task_id: d });

      const report = service.classify(projectId);
      // Ascending sort by numeric id.
      const sortedRoots = [a, c].sort((x, y) => x - y);
      const sortedLeaves = [b, d].sort((x, y) => x - y);
      expect(report.roots).toEqual(sortedRoots);
      expect(report.leaves).toEqual(sortedLeaves);
      // Spot check: arrays really are non-decreasing.
      expect(report.roots).toEqual([...report.roots].sort((x, y) => x - y));
      expect(report.leaves).toEqual([...report.leaves].sort((x, y) => x - y));
    });
  });
});
