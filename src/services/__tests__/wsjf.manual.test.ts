import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { TaskService } from '../task.service.js';
import {
  validateManualScore,
  checkComponentContradictions,
} from '../wsjf.service.js';
import { ValidationError } from '../errors.js';
import type { WsjfWriteDTO } from '../../types/task.js';
import type { WsjfLocks, WsjfSource } from '../../types/wsjf.js';

/**
 * Task #643 — WSJF 4.3: manual WSJF override with per-component locks +
 * provenance.
 *
 * Acceptance criteria:
 *   1. manual set + per-component lock persists with source=manual; writes a
 *      `wsjf_score_history` row with trigger='manual'.
 *   2. a subsequent rescore respects locked components; a contradiction
 *      (jobSize=1 ∧ value=13) is still rejected on the manual path.
 *   3. the manual path is exempt from the classification/evidence requirement
 *      but still enforces enum (Fibonacci) membership.
 */
describe('WSJF manual override + locks + provenance (#643)', () => {
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
    service = new TaskService(taskRepo, projectRepo, db, historyRepo);
    projectId = projectRepo.create({ name: 'Manual Project' }).id;
  });

  afterEach(() => {
    db.close();
  });

  const allLocks = (overrides?: Partial<WsjfLocks>): WsjfLocks => ({
    value: false,
    timeCriticality: false,
    riskOpportunity: false,
    jobSize: false,
    ...overrides,
  });

  const allManualSource = (): WsjfSource => ({
    value: 'manual',
    timeCriticality: 'manual',
    riskOpportunity: 'manual',
    jobSize: 'manual',
  });

  /**
   * A MANUAL write: no `classifications`, no `evidence`, no `features` — just
   * the four components plus the per-component lock + source maps and the
   * `manual` flag. This is exactly what task 4.3 says the manual path accepts.
   */
  const manualWsjf = (overrides?: Partial<WsjfWriteDTO>): WsjfWriteDTO => ({
    value: 8,
    timeCriticality: 5,
    riskOpportunity: 3,
    jobSize: 2,
    manual: true,
    locked: allLocks(),
    source: allManualSource(),
    ...overrides,
  });

  const baseInput = (extra?: Record<string, unknown>) => ({
    title: 'Manually scored task',
    description: 'desc',
    priority: 'medium' as const,
    project_id: projectId,
    created_by: 'human',
    ...extra,
  });

  it('AC1: manual set + per-component lock persists with source=manual and writes history trigger=manual', () => {
    const created = service.createTask(baseInput());
    // Manual override via update_task with no classification/evidence.
    service.updateTask(created.id, {
      wsjf: manualWsjf({
        locked: allLocks({ value: true, jobSize: true }),
      }),
    });

    // Persistence: components + per-component lock + source=manual round-trip.
    const row = taskRepo.findById(created.id)!;
    expect(row.wsjf_value).toBe(8);
    expect(row.wsjf_time_criticality).toBe(5);
    expect(row.wsjf_risk_opportunity).toBe(3);
    expect(row.wsjf_job_size).toBe(2);
    expect(row.wsjf_locked).toEqual(
      allLocks({ value: true, jobSize: true }),
    );
    expect(row.wsjf_source).toEqual(allManualSource());

    // History: exactly one row, trigger='manual', carries lock + source.
    const history = historyRepo.findByTaskId(created.id);
    expect(history).toHaveLength(1);
    expect(history[0].trigger).toBe('manual');
    expect(history[0].source).toEqual(allManualSource());
    expect(history[0].locked).toEqual(
      allLocks({ value: true, jobSize: true }),
    );
    // No classification/evidence was supplied on the manual path.
    expect(history[0].classifications).toBeNull();
    expect(history[0].evidence).toBeNull();
  });

  it('AC2a: a subsequent rescore respects locked components (locked value survives, unlocked component changes)', () => {
    // Initial manual score with `value` LOCKED.
    const created = service.createTask(
      baseInput({
        wsjf: manualWsjf({
          value: 8,
          timeCriticality: 3,
          locked: allLocks({ value: true }),
        }),
      }),
    );
    const before = taskRepo.findById(created.id)!;
    expect(before.wsjf_value).toBe(8);
    expect(before.wsjf_locked).toEqual(allLocks({ value: true }));

    // A rescore proposes new components. The rescore caller is responsible for
    // honouring locks: a locked component is carried forward unchanged, an
    // unlocked one is overwritten. This mirrors task 4.1's "skips locked
    // components" contract using the persisted `wsjf_locked` map.
    const proposed = { value: 13, timeCriticality: 8, riskOpportunity: 5, jobSize: 5 };
    const locks = before.wsjf_locked!;
    const rescored: WsjfWriteDTO = {
      value: locks.value ? before.wsjf_value! : proposed.value,
      timeCriticality: locks.timeCriticality
        ? before.wsjf_time_criticality!
        : proposed.timeCriticality,
      riskOpportunity: locks.riskOpportunity
        ? before.wsjf_risk_opportunity!
        : proposed.riskOpportunity,
      jobSize: locks.jobSize ? before.wsjf_job_size! : proposed.jobSize,
      locked: locks, // locks persist across the rescore
      source: before.wsjf_source!,
      manual: true,
    };
    service.updateTask(created.id, { wsjf: rescored });

    const after = taskRepo.findById(created.id)!;
    // Locked `value` survives the rescore.
    expect(after.wsjf_value).toBe(8);
    // Unlocked components took the rescore's proposal.
    expect(after.wsjf_time_criticality).toBe(8);
    expect(after.wsjf_risk_opportunity).toBe(5);
    expect(after.wsjf_job_size).toBe(5);
    // The lock flag itself persisted.
    expect(after.wsjf_locked).toEqual(allLocks({ value: true }));
  });

  it('AC2b: a contradiction (jobSize=1 ∧ value=13) is still rejected on the manual path', () => {
    const created = service.createTask(baseInput());
    expect(() =>
      service.updateTask(created.id, {
        wsjf: manualWsjf({ value: 13, jobSize: 1 }),
      }),
    ).toThrow(ValidationError);

    // Nothing was persisted and no history row was written.
    const row = taskRepo.findById(created.id)!;
    expect(row.wsjf_value).toBeNull();
    expect(historyRepo.countByTaskId(created.id)).toBe(0);

    // The manual gate reuses #626's contradiction rule verbatim.
    const direct = validateManualScore({
      value: 13,
      timeCriticality: 5,
      riskOpportunity: 3,
      jobSize: 1,
    });
    expect(direct.ok).toBe(false);
    expect(direct.errors.join('\n')).toMatch(/contradiction/);
    expect(checkComponentContradictions({ value: 13, timeCriticality: 5, riskOpportunity: 3, jobSize: 1 })).toHaveLength(1);
  });

  it('AC3a: manual path is exempt from the classification/evidence requirement', () => {
    const created = service.createTask(baseInput());
    // No classification, no evidence, no features supplied — accepted on manual.
    expect(() =>
      service.updateTask(created.id, { wsjf: manualWsjf() }),
    ).not.toThrow();
    expect(taskRepo.findById(created.id)!.wsjf_value).toBe(8);

    // validateManualScore accepts a bare component set (no classification ctx).
    const ok = validateManualScore({
      value: 8,
      timeCriticality: 5,
      riskOpportunity: 3,
      jobSize: 2,
    });
    expect(ok.ok).toBe(true);
    expect(ok.components).toEqual({ value: 8, timeCriticality: 5, riskOpportunity: 3, jobSize: 2 });
  });

  it('AC3b: manual path still enforces enum (Fibonacci) membership', () => {
    // Off-scale tier (7 ∉ {1,2,3,5,8,13}) rejected by the manual gate.
    const bad = validateManualScore({
      value: 7 as unknown,
      timeCriticality: 5,
      riskOpportunity: 3,
      jobSize: 2,
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);

    // And through the service surface: an off-scale component is rejected at
    // the WsjfWriteSchema boundary (FibSchema union) before reaching the DB.
    const created = service.createTask(baseInput());
    expect(() =>
      service.updateTask(created.id, {
        wsjf: { ...manualWsjf(), value: 7 } as unknown as WsjfWriteDTO,
      }),
    ).toThrow(ValidationError);
    expect(taskRepo.findById(created.id)!.wsjf_value).toBeNull();
  });
});
