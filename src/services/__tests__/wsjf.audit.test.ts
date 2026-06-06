import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import {
  WsjfHistoryRepository,
  type IWsjfHistoryRepository,
} from '../../repositories/wsjf-history.repository.js';
import { AppendOnlyViolationError } from '../../repositories/errors.js';
import { TaskService } from '../task.service.js';
import { computeWsjf } from '../wsjf.service.js';
import type { WsjfWriteDTO } from '../../types/task.js';

/**
 * Task #628 — WSJF history repository + in-transaction audit write.
 *
 * Acceptance criteria:
 *   1. create-with-score writes EXACTLY 1 history row with trigger='create'.
 *   2. an update writes another row with the correct prev_wsjf_score; the row
 *      carries classifications + features.
 *   3. UPDATE/DELETE on the history table is rejected by the repository.
 *   4. a write-path test matrix asserts NO component write path bypasses
 *      history.
 */
describe('WSJF audit — history repository + in-transaction write (#628)', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let historyRepo: WsjfHistoryRepository;
  let service: TaskService;
  let projectId: number;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    historyRepo = new WsjfHistoryRepository(db);
    // The audited construction: db + history repo wired so component writes
    // and history rows commit in one transaction.
    service = new TaskService(taskRepo, projectRepo, db, historyRepo);
    projectId = projectRepo.create({ name: 'Audit Project' }).id;
  });

  afterEach(() => {
    db.close();
  });

  const fullWsjf = (overrides?: Partial<WsjfWriteDTO>): WsjfWriteDTO => ({
    value: 8,
    timeCriticality: 5,
    riskOpportunity: 3,
    jobSize: 2,
    evidence: {
      value: 'aligns with reliability theme',
      timeCriticality: 'launch window closes Q3',
      riskOpportunity: 'prevents dropped carts',
      jobSize: 'single-file config change',
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
      severity: 'tech_debt',
      decay: 'slow',
      jobSizeTier: 2,
      evidence: {
        value: 'aligns with reliability theme',
        timeCriticality: 'launch window closes Q3',
        riskOpportunity: 'prevents dropped carts',
        jobSize: 'single-file config change',
      },
    },
    features: {
      deadlineDate: '2026-09-30T00:00:00.000Z',
      daysUntilDeadline: 121,
      transitiveDependents: 2,
      filesTouched: 1,
      charterVersion: 1,
    },
    ...overrides,
  });

  const baseInput = (extra?: Record<string, unknown>) => ({
    title: 'Audited task',
    description: 'desc',
    priority: 'medium' as const,
    project_id: projectId,
    created_by: 'tester',
    ...extra,
  });

  it('AC1: create-with-score writes exactly 1 history row with trigger=create', () => {
    const wsjf = fullWsjf();
    const task = service.createTask(baseInput({ wsjf }));

    const rows = historyRepo.findByTaskId(task.id);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row.trigger).toBe('create');
    expect(row.task_id).toBe(task.id);
    expect(row.project_id).toBe(projectId);
    // Components recorded.
    expect(row.value).toBe(8);
    expect(row.time_criticality).toBe(5);
    expect(row.risk_opportunity).toBe(3);
    expect(row.job_size).toBe(2);
    // Server-computed score from the components.
    expect(row.wsjf_score).toBeCloseTo(
      computeWsjf({ value: 8, timeCriticality: 5, riskOpportunity: 3, jobSize: 2 }),
      10,
    );
    // First write → no prior score.
    expect(row.prev_wsjf_score).toBeNull();
  });

  it('AC2: an update writes another row with the correct prev_wsjf_score + classifications + features', () => {
    const created = service.createTask(baseInput({ wsjf: fullWsjf() }));
    const prevScore = computeWsjf({
      value: 8,
      timeCriticality: 5,
      riskOpportunity: 3,
      jobSize: 2,
    });

    // Re-score: different components.
    const next = fullWsjf({ value: 13, timeCriticality: 8, riskOpportunity: 5, jobSize: 5 });
    service.updateTask(created.id, { wsjf: next });

    const rows = historyRepo.findByTaskId(created.id);
    expect(rows).toHaveLength(2);

    const [, updateRow] = rows; // oldest-first ordering
    expect(updateRow.trigger).toBe('update');
    expect(updateRow.value).toBe(13);
    expect(updateRow.job_size).toBe(5);
    // prev_wsjf_score is the score BEFORE this write.
    expect(updateRow.prev_wsjf_score).toBeCloseTo(prevScore, 10);
    expect(updateRow.wsjf_score).toBeCloseTo(
      computeWsjf({ value: 13, timeCriticality: 8, riskOpportunity: 5, jobSize: 5 }),
      10,
    );
    // Row carries the raw classifications + deterministic features.
    expect(updateRow.classifications).toEqual(next.classifications);
    expect(updateRow.features).toEqual(next.features);
  });

  it('AC3: UPDATE/DELETE on the history table is rejected by the repository', () => {
    const created = service.createTask(baseInput({ wsjf: fullWsjf() }));
    // Sanity: a row exists.
    expect(historyRepo.countByTaskId(created.id)).toBe(1);

    const repo: IWsjfHistoryRepository = historyRepo;
    expect(() => repo.update()).toThrow(AppendOnlyViolationError);
    expect(() => repo.delete()).toThrow(AppendOnlyViolationError);

    // The guard never issues SQL — the existing row is untouched.
    expect(historyRepo.countByTaskId(created.id)).toBe(1);
  });

  it('AC4 (write-path matrix): every component write path appends history; non-score paths do not', () => {
    // Path A: create WITH score → 1 history row.
    const withScore = service.createTask(baseInput({ wsjf: fullWsjf() }));
    expect(historyRepo.countByTaskId(withScore.id)).toBe(1);

    // Path B: create WITHOUT score → 0 history rows (nothing to audit).
    const noScore = service.createTask(baseInput({ title: 'no score' }));
    expect(historyRepo.countByTaskId(noScore.id)).toBe(0);

    // Path C: update sets a score on a previously-unscored task → 1 new row,
    //         prev_wsjf_score null (was unscored).
    service.updateTask(noScore.id, { wsjf: fullWsjf() });
    const cRows = historyRepo.findByTaskId(noScore.id);
    expect(cRows).toHaveLength(1);
    expect(cRows[0].trigger).toBe('update');
    expect(cRows[0].prev_wsjf_score).toBeNull();

    // Path D: update that does NOT touch wsjf → no new history row.
    service.updateTask(withScore.id, { title: 'renamed' });
    expect(historyRepo.countByTaskId(withScore.id)).toBe(1);

    // Path E: clearing the score (wsjf: null) is not a component-value write →
    //         no new history row (and the component columns clear).
    service.updateTask(withScore.id, { wsjf: null });
    expect(historyRepo.countByTaskId(withScore.id)).toBe(1);
    const cleared = taskRepo.findById(withScore.id)!;
    expect(cleared.wsjf_value).toBeNull();

    // Atomicity check: the only way a history row exists is via a real score
    // write — the count equals the number of score-bearing component writes.
    // withScore: 1 (create). noScore: 1 (update set). Total scored writes = 2.
    const total = historyRepo.countByTaskId(withScore.id) + historyRepo.countByTaskId(noScore.id);
    expect(total).toBe(2);
  });

  it('atomicity: a component write and its history row commit together', () => {
    const created = service.createTask(baseInput({ wsjf: fullWsjf() }));
    // Both the task row and the history row are visible after the same call.
    const task = taskRepo.findById(created.id)!;
    expect(task.wsjf_value).toBe(8);
    expect(historyRepo.countByTaskId(created.id)).toBe(1);
  });

  it('back-compat: a TaskService without the audit hook persists the score but writes no history', () => {
    const unaudited = new TaskService(taskRepo, projectRepo);
    const created = unaudited.createTask(baseInput({ wsjf: fullWsjf() }));
    const task = taskRepo.findById(created.id)!;
    expect(task.wsjf_value).toBe(8); // score still persisted
    expect(historyRepo.countByTaskId(created.id)).toBe(0); // no audit row
  });
});
