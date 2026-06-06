import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { TopologyService } from '../topology.service.js';
import { DependencyService } from '../dependency.service.js';
import {
  rankFrontier,
  computeWsjf,
  PROPAGATION_GAMMA,
  PROPAGATION_CAP,
  type RankDeps,
  type RankedTask,
} from '../wsjf.service.js';
import type { TaskPriority, WsjfWriteDTO } from '../../types/task.js';

// ---------------------------------------------------------------------------
// Task #629 (WSJF 1.9) — acceptance tests for `rankFrontier` + propagation.
//
// Each scenario builds REAL repositories against a fresh in-memory SQLite so
// the ranker exercises the same findByFilters / findAll / topology paths it
// uses in production (mirrors the TopologyService unit-test strategy).
// ---------------------------------------------------------------------------

describe('rankFrontier (WSJF 1.9)', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let depRepo: DependencyRepository;
  let deps: RankDeps;
  let projectId: number;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    depRepo = new DependencyRepository(db);
    deps = {
      topology: new TopologyService(taskRepo, depRepo),
      dependency: new DependencyService(depRepo, taskRepo),
      tasks: taskRepo,
    };
    const p = projectRepo.create({ name: 'Rank Project' });
    projectId = p.id;
  });

  /** A scored wsjf payload from raw component tiers. */
  function wsjf(
    value: WsjfWriteDTO['value'],
    timeCriticality: WsjfWriteDTO['timeCriticality'],
    riskOpportunity: WsjfWriteDTO['riskOpportunity'],
    jobSize: WsjfWriteDTO['jobSize'],
  ): WsjfWriteDTO {
    return { value, timeCriticality, riskOpportunity, jobSize };
  }

  function createTask(
    title: string,
    opts: {
      wsjf?: WsjfWriteDTO;
      priority?: TaskPriority;
      status?: 'open' | 'blocked';
    } = {},
  ): number {
    const t = taskRepo.create({
      title,
      status: opts.status ?? 'open',
      priority: opts.priority ?? 'medium',
      project_id: projectId,
      created_by: 'test-agent',
      wsjf: opts.wsjf ?? null,
    });
    return t.id;
  }

  /** edge from→to means `from` blocks `to` (to is downstream dependent). */
  function dependency(from: number, to: number): void {
    depRepo.create({ task_id: from, blocks_task_id: to });
  }

  /** Force a deterministic created_at on a row (repo always stamps `now`). */
  function setCreatedAt(id: number, iso: string): void {
    db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(iso, id);
  }

  function byId(ranked: RankedTask[], id: number): RankedTask {
    const r = ranked.find((x) => x.taskId === id);
    if (!r) throw new Error(`task ${id} not in ranking`);
    return r;
  }

  // -------------------------------------------------------------------------
  // AC1 — linear chain A→B→C raises blocker A's effectiveWsjf by γ-discounted
  //       dependents.
  // -------------------------------------------------------------------------
  it('linear chain A→B→C raises blocker A by γ-discounted dependents', async () => {
    // base_CoD = value + tc + rr. Use jobSize 1 so effective_CoD == effective_wsjf.
    const a = createTask('A', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    const b = createTask('B', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    const c = createTask('C', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    dependency(a, b); // A blocks B
    dependency(b, c); // B blocks C

    const ranked = await rankFrontier(projectId, 'all', deps);
    const ra = byId(ranked, a);

    // A's downstream: B at dist 1 (γ^0 = 1), C at dist 2 (γ^1 = 0.5).
    const expectedEff = 6 + 6 * Math.pow(PROPAGATION_GAMMA, 0) + 6 * Math.pow(PROPAGATION_GAMMA, 1);
    // = 6 + 6 + 3 = 15, but capped at base*CAP = 6*3 = 18 → not hit.
    expect(ra.effectiveWsjf).toBeCloseTo(expectedEff, 10);
    expect(ra.baseWsjf).toBeCloseTo(6, 10);
    // effective strictly greater than base (propagation lifted it).
    expect(ra.effectiveWsjf).toBeGreaterThan(ra.baseWsjf as number);

    // Propagation breakdown lists B (contrib 6) and C (contrib 3).
    const contribs = Object.fromEntries(ra.propagation.map((p) => [p.dependentId, p.contribution]));
    expect(contribs[b]).toBeCloseTo(6, 10);
    expect(contribs[c]).toBeCloseTo(3, 10);
    expect(ra.propagation).toHaveLength(2);

    // C is a leaf — no propagation, effective == base.
    const rc = byId(ranked, c);
    expect(rc.propagation).toHaveLength(0);
    expect(rc.effectiveWsjf).toBeCloseTo(6, 10);

    // A ranks first (highest effective).
    expect(ranked[0].taskId).toBe(a);
  });

  // -------------------------------------------------------------------------
  // AC2 — diamond A→{B,C}→D: D counted ONCE for A (closure dedupe); and the
  //       cap effective <= base*3 holds.
  // -------------------------------------------------------------------------
  it('diamond A→{B,C}→D counts D once for A (closure dedupe) and respects cap', async () => {
    const a = createTask('A', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    const b = createTask('B', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    const c = createTask('C', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    const d = createTask('D', { wsjf: wsjf(2, 2, 2, 1) }); // base 6
    dependency(a, b);
    dependency(a, c);
    dependency(b, d);
    dependency(c, d);

    const ranked = await rankFrontier(projectId, 'all', deps);
    const ra = byId(ranked, a);

    // Distinct dependents of A: B(d1), C(d1), D(d2 via shortest path). D once.
    const dEntries = ra.propagation.filter((p) => p.dependentId === d);
    expect(dEntries).toHaveLength(1);
    expect(dEntries[0].contribution).toBeCloseTo(6 * Math.pow(PROPAGATION_GAMMA, 1), 10); // dist 2 → γ^1 = 3

    // B + C at dist 1 (6 each) + D once at dist 2 (3) = 15 added to base 6 = 21,
    // but capped at base*CAP = 6*3 = 18.
    const uncapped = 6 + 6 + 6 + 3;
    expect(uncapped).toBeGreaterThan(6 * PROPAGATION_CAP);
    expect(ra.effectiveWsjf).toBeCloseTo(6 * PROPAGATION_CAP, 10);
    // Cap invariant: effective <= base * 3.
    expect(ra.effectiveWsjf).toBeLessThanOrEqual((ra.baseWsjf as number) * PROPAGATION_CAP + 1e-9);
  });

  // -------------------------------------------------------------------------
  // AC3 — cyclic input rejected via the topology DAG_CYCLIC guard.
  // -------------------------------------------------------------------------
  it('rejects cyclic input via the topology DAG_CYCLIC guard', async () => {
    const x = createTask('X', { wsjf: wsjf(2, 2, 2, 1) });
    const y = createTask('Y', { wsjf: wsjf(2, 2, 2, 1) });
    const z = createTask('Z', { wsjf: wsjf(2, 2, 2, 1) });
    // Insert raw cyclic edges (bypass DependencyService cycle guard) X→Y→Z→X.
    depRepo.create({ task_id: x, blocks_task_id: y });
    depRepo.create({ task_id: y, blocks_task_id: z });
    depRepo.create({ task_id: z, blocks_task_id: x });

    // Sanity: topology classifies it cyclic.
    expect(deps.topology.classify(projectId).topology).toBe('DAG_CYCLIC');

    await expect(rankFrontier(projectId, 'all', deps)).rejects.toThrow(/cyclic|DAG_CYCLIC/i);
  });

  // -------------------------------------------------------------------------
  // AC4 — mixed scored/unscored: unscored sorted via priorityFallbackScore,
  //       ties broken by created_at then id; scope:'frontier' excludes blocked.
  // -------------------------------------------------------------------------
  it('mixed scored/unscored: fallback ordering with created_at/id tie-break', async () => {
    // Scored task with a real ratio.
    const scored = createTask('scored', { wsjf: wsjf(8, 5, 8, 5) }); // base 21, ratio 4.2
    // Unscored urgent (fallback 9) and two unscored medium (fallback 3) with
    // identical created_at to force the created_at→id tie-break.
    const urgent = createTask('urgent', { priority: 'urgent' });
    const med1 = createTask('med1', { priority: 'medium' });
    const med2 = createTask('med2', { priority: 'medium' });
    setCreatedAt(med1, '2026-06-01T00:00:00.000Z');
    setCreatedAt(med2, '2026-06-01T00:00:00.000Z'); // tie → lower id (med1) first

    const ranked = await rankFrontier(projectId, 'all', deps);

    // urgent (9) > scored (4.2) > med1 (3) > med2 (3, same created_at, higher id).
    expect(ranked.map((r) => r.taskId)).toEqual([urgent, scored, med1, med2]);

    const ru = byId(ranked, urgent);
    expect(ru.scored).toBe(false);
    expect(ru.baseWsjf).toBeNull();
    expect(ru.components).toBeNull();
    expect(ru.effectiveWsjf).toBe(9);

    const rs = byId(ranked, scored);
    expect(rs.scored).toBe(true);
    expect(rs.baseWsjf).toBeCloseTo(
      computeWsjf({ value: 8, timeCriticality: 5, riskOpportunity: 8, jobSize: 5 }),
      10,
    );

    // med1 before med2: same fallback score + same created_at, lower id wins.
    const idxMed1 = ranked.findIndex((r) => r.taskId === med1);
    const idxMed2 = ranked.findIndex((r) => r.taskId === med2);
    expect(idxMed1).toBeLessThan(idxMed2);
  });

  it("scope:'frontier' excludes blocked tasks (status + unsatisfied blockers)", async () => {
    const ready = createTask('ready', { wsjf: wsjf(2, 2, 2, 1) });
    const blockedStatus = createTask('blocked-status', {
      wsjf: wsjf(2, 2, 2, 1),
      status: 'blocked',
    });
    // dependent has an OPEN (not done) blocker → not on frontier.
    const blocker = createTask('blocker', { wsjf: wsjf(2, 2, 2, 1) });
    const dependent = createTask('dependent', { wsjf: wsjf(2, 2, 2, 1) });
    dependency(blocker, dependent); // blocker (open) blocks dependent

    const frontier = await rankFrontier(projectId, 'frontier', deps);
    const ids = frontier.map((r) => r.taskId);

    expect(ids).toContain(ready);
    expect(ids).toContain(blocker); // blocker itself has no incoming edge → ready
    expect(ids).not.toContain(blockedStatus); // status === 'blocked'
    expect(ids).not.toContain(dependent); // open blocker not satisfied

    // scope:'all' includes everyone.
    const all = await rankFrontier(projectId, 'all', deps);
    expect(all.map((r) => r.taskId).sort((a, b) => a - b)).toEqual(
      [ready, blockedStatus, blocker, dependent].sort((a, b) => a - b),
    );
  });

  it('frontier admits a dependent once its blocker is done', async () => {
    const blocker = createTask('blocker', { wsjf: wsjf(2, 2, 2, 1) });
    const dependent = createTask('dependent', { wsjf: wsjf(2, 2, 2, 1) });
    dependency(blocker, dependent);
    // Mark blocker done.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(blocker);

    const frontier = await rankFrontier(projectId, 'frontier', deps);
    expect(frontier.map((r) => r.taskId)).toContain(dependent);
  });
});
