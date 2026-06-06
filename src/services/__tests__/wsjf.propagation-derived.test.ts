import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { TaskService } from '../task.service.js';
import { derivePropagatedValuePrior } from '../wsjf.service.js';
import type { WsjfWriteDTO } from '../../types/task.js';
import type { WsjfClassification, WsjfLocks, WsjfSource } from '../../types/wsjf.js';

/**
 * Task #644 — WSJF 4.4: propagation of a scored parent's VALUE prior to derived
 * tasks (subtasks + decompose children).
 *
 * Acceptance criteria:
 *   1. child of a scored parent inherits the parent's value theme + UBV prior.
 *   2. objective components on the child are scored FRESH (not copied from
 *      the parent).
 *   3. the human-anchored flag is set when the parent's value was manual.
 *
 * Design spec §8.5: "children inherit the parent's value-theme mapping + a
 * Business-Value prior (value flows down the tree); per-child objective
 * components (Job Size, fan-out) are scored fresh. A manually-set parent value
 * is propagated as a human-anchored prior (flagged so it is visible)."
 */
describe('WSJF propagation to derived tasks (#644)', () => {
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
    projectId = projectRepo.create({ name: 'Propagation Project' }).id;
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

  const sourceWith = (value: 'auto' | 'manual'): WsjfSource => ({
    value,
    timeCriticality: 'auto',
    riskOpportunity: 'auto',
    jobSize: 'auto',
  });

  const classification = (themeName: string | null): WsjfClassification => ({
    themeName,
    alignment: 'core',
    severity: 'none',
    decay: 'flat',
    jobSizeTier: 5,
    evidence: {
      value: 'v',
      timeCriticality: 't',
      riskOpportunity: 'r',
      jobSize: 'j',
    },
  });

  const baseInput = (extra?: Record<string, unknown>) => ({
    title: 'Parent task',
    description: 'desc',
    priority: 'medium' as const,
    project_id: projectId,
    created_by: 'agent',
    ...extra,
  });

  /** Create a fully-scored AUTO parent carrying a theme mapping. */
  const createScoredParent = (over?: Partial<WsjfWriteDTO>, theme: string | null = 'Retention') => {
    const wsjf: WsjfWriteDTO = {
      value: 8,
      timeCriticality: 5,
      riskOpportunity: 3,
      jobSize: 2,
      classifications: classification(theme),
      source: sourceWith('auto'),
      locked: allLocks(),
      ...over,
    };
    return service.createTask(baseInput({ wsjf }));
  };

  it('AC1: child of a scored parent inherits parent value theme + UBV prior', () => {
    const parent = createScoredParent({ value: 8 }, 'Retention');

    const prior = service.derivePropagatedValuePrior(parent.id);
    expect(prior).not.toBeNull();
    // Inherited Business-Value (UBV) prior == parent's value tier.
    expect(prior!.value).toBe(8);
    // Inherited value-theme mapping == parent's theme.
    expect(prior!.themeName).toBe('Retention');
  });

  it('AC2: objective components on the child are scored fresh (not copied)', () => {
    // Parent has DISTINCTIVE objective components.
    const parent = createScoredParent({
      value: 8,
      timeCriticality: 13,
      riskOpportunity: 13,
      jobSize: 13,
    });

    const prior = service.derivePropagatedValuePrior(parent.id)!;

    // The propagated prior carries ONLY the value dimension — no objective
    // components are present to be copied down.
    expect(prior).toEqual({
      value: 8,
      themeName: 'Retention',
      humanAnchored: false,
    });
    expect(prior).not.toHaveProperty('timeCriticality');
    expect(prior).not.toHaveProperty('riskOpportunity');
    expect(prior).not.toHaveProperty('jobSize');

    // A child created with FRESH objective components keeps them — the prior
    // never overwrites the child's own time-criticality / risk / job-size.
    const child = service.createTask(
      baseInput({
        title: 'Child task',
        parent_task_id: parent.id,
        wsjf: {
          value: prior.value, // inherited
          timeCriticality: 2, // fresh, differs from parent's 13
          riskOpportunity: 1, // fresh, differs from parent's 13
          jobSize: 3, // fresh, differs from parent's 13
          classifications: classification(prior.themeName),
          source: sourceWith('auto'),
          locked: allLocks(),
        } satisfies WsjfWriteDTO,
      }),
    );
    const row = taskRepo.findById(child.id)!;
    expect(row.wsjf_value).toBe(8); // inherited value
    expect(row.wsjf_time_criticality).toBe(2); // fresh, NOT parent's 13
    expect(row.wsjf_risk_opportunity).toBe(1); // fresh, NOT parent's 13
    expect(row.wsjf_job_size).toBe(3); // fresh, NOT parent's 13
  });

  it('AC3: human-anchored flag set when the parent value was manual', () => {
    const manualParent = createScoredParent({
      value: 13,
      manual: true,
      source: sourceWith('manual'),
      classifications: null, // manual path has no classification
    });

    const prior = service.derivePropagatedValuePrior(manualParent.id)!;
    expect(prior.value).toBe(13);
    expect(prior.humanAnchored).toBe(true);
    // No charter classification on a manual parent → themeName flows as null.
    expect(prior.themeName).toBeNull();
  });

  it('auto-scored parent propagates a NON-human-anchored prior', () => {
    const parent = createScoredParent({ source: sourceWith('auto') });
    const prior = service.derivePropagatedValuePrior(parent.id)!;
    expect(prior.humanAnchored).toBe(false);
  });

  it('unscored parent yields no prior (child scored entirely fresh)', () => {
    const parent = service.createTask(baseInput());
    expect(service.derivePropagatedValuePrior(parent.id)).toBeNull();
  });

  it('missing parent yields no prior', () => {
    expect(service.derivePropagatedValuePrior(999999)).toBeNull();
  });

  it('pure helper: derives value + themeName + humanAnchored from parent state', () => {
    expect(
      derivePropagatedValuePrior({
        wsjf_value: 5,
        wsjf_classifications: classification('Growth'),
        wsjf_source: sourceWith('manual'),
      }),
    ).toEqual({ value: 5, themeName: 'Growth', humanAnchored: true });

    // Unscored parent → null.
    expect(
      derivePropagatedValuePrior({
        wsjf_value: null,
        wsjf_classifications: null,
        wsjf_source: null,
      }),
    ).toBeNull();
  });
});
