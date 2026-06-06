import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { DependencyRepository } from '../../repositories/dependency.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { WsjfRescoreRepository } from '../../repositories/wsjf-rescore.repository.js';
import { TaskService } from '../task.service.js';
import { TopologyService } from '../topology.service.js';
import { WsjfRescoreService } from '../wsjf-rescore.service.js';
import type { ScoreSubmission } from '../wsjf.service.js';
import type { ValueCharter, WsjfWriteDTO } from '../../types/task.js';
import type { WsjfLocks } from '../../types/wsjf.js';

/**
 * Task #641 — WSJF 4.1: deterministic project rescore engine.
 *
 * Acceptance criteria:
 *   - locked components are untouched by a rescore.
 *   - every changed component links to the opened wsjf_rescore_run via
 *     rescore_run_id; deterministic given the same charter + tasks.
 *   - rescore_project is registered through registerWsjfTools and returns a
 *     run summary (covered in src/mcp/__tests__/wsjf-tools.test.ts is the
 *     production wiring; here we assert the service-level run summary shape).
 */
describe('WSJF rescore service (#641)', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let dependencyRepo: DependencyRepository;
  let historyRepo: WsjfHistoryRepository;
  let runsRepo: WsjfRescoreRepository;
  let topology: TopologyService;
  let taskService: TaskService;
  let rescore: WsjfRescoreService;
  let projectId: number;

  // A charter with two value themes of differing weight so an alignment change
  // moves the UBV (value) component deterministically.
  const charter: ValueCharter = {
    mission: 'Ship a reliable storefront',
    value_themes: [
      { name: 'reliability', weight: 13, description: 'keep checkout working' },
      { name: 'growth', weight: 5, description: 'acquire new users' },
    ],
    time_context: 'launch window closes Q3',
    risk_posture: 'avoid data loss at all costs',
    out_of_scope: [],
    interview_version: 2,
    updated_at: '2026-06-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    dependencyRepo = new DependencyRepository(db);
    historyRepo = new WsjfHistoryRepository(db);
    runsRepo = new WsjfRescoreRepository(db);
    topology = new TopologyService(taskRepo, dependencyRepo);
    taskService = new TaskService(taskRepo, projectRepo, db, historyRepo);
    rescore = new WsjfRescoreService({
      db,
      tasks: taskRepo,
      projects: projectRepo,
      history: historyRepo,
      runs: runsRepo,
      topology,
    });
    projectId = projectRepo.create({
      name: 'Rescore Project',
      value_charter: charter,
    }).id;
  });

  afterEach(() => {
    db.close();
  });

  /** A scored task whose evidence spans are verbatim substrings of its text. */
  function scoredTask(title: string, wsjf: WsjfWriteDTO): number {
    const created = taskService.createTask({
      title,
      description: 'aligns with reliability theme; launch window closes Q3',
      priority: 'medium' as const,
      project_id: projectId,
      created_by: 'tester',
      wsjf,
    });
    return created.id;
  }

  /** A full auto WSJF write (all spans verbatim substrings of the seed text). */
  function autoWsjf(overrides?: Partial<WsjfWriteDTO>): WsjfWriteDTO {
    return {
      value: 13,
      timeCriticality: 8,
      riskOpportunity: 8,
      jobSize: 2,
      evidence: {
        value: 'aligns with reliability theme',
        timeCriticality: 'launch window closes Q3',
        riskOpportunity: 'launch window closes Q3',
        jobSize: 'aligns with reliability theme',
      },
      source: {
        value: 'auto',
        timeCriticality: 'auto',
        riskOpportunity: 'auto',
        jobSize: 'auto',
      },
      classifications: {
        themeName: 'reliability',
        alignment: 'core',
        severity: 'data_loss',
        decay: null,
        jobSizeTier: 2,
        evidence: {
          value: 'aligns with reliability theme',
          timeCriticality: 'launch window closes Q3',
          riskOpportunity: 'launch window closes Q3',
          jobSize: 'aligns with reliability theme',
        },
      },
      features: {
        deadlineDate: null,
        daysUntilDeadline: 5,
        transitiveDependents: 0,
        filesTouched: 2,
        charterVersion: 2,
      },
      ...overrides,
    };
  }

  /**
   * A written-back submission. By default it classifies the task with WEAK
   * alignment to reliability (weight 13) → UBV drops from 13 (core) to 5
   * (two steps down: 13→8→5), so the value component changes on rescore.
   */
  function submission(overrides?: Partial<ScoreSubmission['classification']>): ScoreSubmission {
    return {
      classification: {
        themeName: 'reliability',
        alignment: 'weak',
        severity: 'data_loss',
        decay: null,
        jobSizeTier: 2,
        evidence: {
          value: 'aligns with reliability theme',
          timeCriticality: 'launch window closes Q3',
          riskOpportunity: 'launch window closes Q3',
          jobSize: 'aligns with reliability theme',
        },
        ...overrides,
      },
      features: {
        deadlineDate: null,
        daysUntilDeadline: 5,
        transitiveDependents: 0,
        filesTouched: 2,
        charterVersion: 2,
      },
    };
  }

  it('collectRescoreSet returns scored tasks + charter + graph signals', () => {
    const a = scoredTask('Fix checkout', autoWsjf());
    // An unscored task is NOT a rescore candidate.
    taskService.createTask({
      title: 'Unscored task',
      priority: 'low' as const,
      project_id: projectId,
      created_by: 'tester',
    });

    const set = rescore.collectRescoreSet(projectId);
    expect(set.charter).not.toBeNull();
    expect(set.charter!.interview_version).toBe(2);
    expect(set.tasks.map((t) => t.id)).toEqual([a]);
    expect(set.graphSignals).toEqual([{ taskId: a, transitiveDependents: 0 }]);
  });

  // AC: locked components are untouched by a rescore.
  it('skips locked components — locked value is preserved, unlocked recomputed', () => {
    const locked: WsjfLocks = {
      value: true,
      timeCriticality: false,
      riskOpportunity: false,
      jobSize: false,
    };
    // Seed: value=13 (core), and LOCK the value component.
    const taskId = scoredTask('Fix checkout', autoWsjf({ locked }));

    // Submit a WEAK-alignment classification that WOULD recompute value to 5.
    const result = rescore.rescore(projectId, [{ taskId, submission: submission() }]);

    expect(result.tasksEvaluated).toBe(1);
    expect(result.tasksSkippedLocked).toBe(1);

    const taskResult = result.results.find((r) => r.taskId === taskId)!;
    expect(taskResult.skippedLocked).toContain('value');
    // Locked value preserved at 13 despite the weak submission (would be 5).
    expect(taskResult.components.value).toBe(13);

    const persisted = taskRepo.findById(taskId)!;
    expect(persisted.wsjf_value).toBe(13);
    // The lock map survived the rescore write unchanged.
    expect(persisted.wsjf_locked).toEqual(locked);
  });

  it('a fully-locked task is never written and counts as skipped, not changed', () => {
    const locked: WsjfLocks = {
      value: true,
      timeCriticality: true,
      riskOpportunity: true,
      jobSize: true,
    };
    const taskId = scoredTask('Fix checkout', autoWsjf({ locked }));
    const beforeRows = historyRepo.countByTaskId(taskId);

    const result = rescore.rescore(projectId, [{ taskId, submission: submission() }]);

    const taskResult = result.results.find((r) => r.taskId === taskId)!;
    expect(taskResult.changed).toBe(false);
    expect(result.tasksChanged).toBe(0);
    // No new history row for an all-locked (unchanged) task.
    expect(historyRepo.countByTaskId(taskId)).toBe(beforeRows);
  });

  // AC: every changed component links to the opened run via rescore_run_id.
  it('links every changed task history row to the opened wsjf_rescore_run', () => {
    const a = scoredTask('Fix checkout', autoWsjf());
    const b = scoredTask('Fix payments', autoWsjf());

    const result = rescore.rescore(projectId, [
      { taskId: a, submission: submission() },
      { taskId: b, submission: submission() },
    ]);

    expect(result.tasksChanged).toBe(2);
    expect(result.runId).toBeGreaterThan(0);

    // The run record exists with the rollup counts.
    const run = runsRepo.findById(result.runId)!;
    expect(run.project_id).toBe(projectId);
    expect(run.tasks_evaluated).toBe(2);
    expect(run.tasks_changed).toBe(2);
    expect(run.charter_version).toBe(2);

    // Each changed task's NEWEST history row links by rescore_run_id.
    for (const taskId of [a, b]) {
      const rows = historyRepo.findByTaskId(taskId);
      const last = rows[rows.length - 1];
      expect(last.trigger).toBe('rescore');
      expect(last.rescore_run_id).toBe(result.runId);
      // value recomputed from core(13)→weak(5).
      expect(last.value).toBe(5);
    }
  });

  // AC: deterministic given the same charter + tasks.
  it('is deterministic — identical charter + tasks + submissions yield identical components', () => {
    const a1 = scoredTask('Fix checkout', autoWsjf());
    const r1 = rescore.rescore(projectId, [{ taskId: a1, submission: submission() }]);
    const comp1 = r1.results[0].components;

    // Fresh project + identical inputs in a second DB → identical components.
    const db2 = initDatabase(':memory:');
    return runMigrations(db2).then(() => {
      const pr2 = new ProjectRepository(db2);
      const tr2 = new TaskRepository(db2);
      const dr2 = new DependencyRepository(db2);
      const hr2 = new WsjfHistoryRepository(db2);
      const rr2 = new WsjfRescoreRepository(db2);
      const topo2 = new TopologyService(tr2, dr2);
      const ts2 = new TaskService(tr2, pr2, db2, hr2);
      const rescore2 = new WsjfRescoreService({
        db: db2,
        tasks: tr2,
        projects: pr2,
        history: hr2,
        runs: rr2,
        topology: topo2,
      });
      const p2 = pr2.create({ name: 'Rescore Project', value_charter: charter }).id;
      const a2 = ts2.createTask({
        title: 'Fix checkout',
        description: 'aligns with reliability theme; launch window closes Q3',
        priority: 'medium' as const,
        project_id: p2,
        created_by: 'tester',
        wsjf: autoWsjf(),
      }).id;
      const r2 = rescore2.rescore(p2, [{ taskId: a2, submission: submission() }]);

      expect(r2.results[0].components).toEqual(comp1);
      expect(r2.tasksChanged).toBe(r1.tasksChanged);
      db2.close();
    });
  });

  it('records per-task validation errors without aborting the rest of the batch', () => {
    const good = scoredTask('Fix checkout', autoWsjf());
    const bad = scoredTask('Fix payments', autoWsjf());

    const result = rescore.rescore(projectId, [
      { taskId: good, submission: submission() },
      // A non-verbatim evidence span fails the gate for this one task.
      {
        taskId: bad,
        submission: submission({
          evidence: {
            value: 'this span does not occur in the task text',
            timeCriticality: 'launch window closes Q3',
            riskOpportunity: 'launch window closes Q3',
            jobSize: 'aligns with reliability theme',
          },
        }),
      },
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe(bad);
    // The good task still changed + committed.
    expect(result.tasksChanged).toBe(1);
    expect(result.results.map((r) => r.taskId)).toEqual([good]);
  });
});
