import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../project.repository.js';
import { TaskRepository } from '../task.repository.js';
import { CreateTaskClientSchema, UpdateTaskClientSchema } from '../../schemas/task.schema.js';
import type { CreateTaskDTO, WsjfWriteDTO } from '../../types/task.js';

/**
 * Task #627 — WSJF persistence + all-four-or-none enforcement.
 *
 * Covers the three acceptance criteria:
 *   1. a task created with full components persists and reads back the components
 *   2. a half-scored task (not all four) is rejected by all-four-or-none enforcement
 *   3. an unscored task is unaffected (every wsjf_* field reads back null)
 */
describe('TaskRepository — WSJF persistence (#627)', () => {
  let db: Database.Database;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;
  let testProjectId: number;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    const project = projectRepo.create({
      name: 'WSJF Test Project',
      description: 'Project for WSJF persistence tests',
    });
    testProjectId = project.id;
  });

  const baseDto = (overrides?: Partial<CreateTaskDTO>): CreateTaskDTO => ({
    title: 'WSJF Task',
    description: 'desc',
    status: 'open',
    priority: 'medium',
    project_id: testProjectId,
    created_by: 'test-user',
    ...overrides,
  });

  const fullWsjf: WsjfWriteDTO = {
    value: 8,
    timeCriticality: 5,
    riskOpportunity: 3,
    jobSize: 2,
    evidence: {
      value: 'aligns with checkout reliability theme',
      timeCriticality: 'launch window closes Q3',
      riskOpportunity: 'prevents dropped carts',
      jobSize: 'single-file config change',
    },
    locked: {
      value: false,
      timeCriticality: false,
      riskOpportunity: true,
      jobSize: false,
    },
    source: {
      value: 'auto',
      timeCriticality: 'auto',
      riskOpportunity: 'manual',
      jobSize: 'auto',
    },
    features: {
      deadlineDate: '2026-09-30T00:00:00.000Z',
      daysUntilDeadline: 121,
      transitiveDependents: 2,
      filesTouched: 1,
      charterVersion: 1,
    },
  };

  it('AC1: a task created with full components persists and reads back the components', () => {
    const created = taskRepo.create(baseDto({ wsjf: fullWsjf }));

    // Re-read through findById to exercise the read/inflate path.
    const read = taskRepo.findById(created.id)!;
    expect(read).not.toBeNull();

    // Component INTEGER columns round-trip as numbers.
    expect(read.wsjf_value).toBe(8);
    expect(read.wsjf_time_criticality).toBe(5);
    expect(read.wsjf_risk_opportunity).toBe(3);
    expect(read.wsjf_job_size).toBe(2);

    // JSON metadata columns inflate to parsed objects (not raw strings).
    expect(read.wsjf_evidence).toEqual(fullWsjf.evidence);
    expect(read.wsjf_locked).toEqual(fullWsjf.locked);
    expect(read.wsjf_source).toEqual(fullWsjf.source);
    expect(read.wsjf_features).toEqual(fullWsjf.features);
    // classifications was not supplied → null.
    expect(read.wsjf_classifications).toBeNull();
  });

  it('AC2: a half-scored task (not all four) is rejected by all-four-or-none enforcement', () => {
    // Only `value` supplied — the other three components are missing.
    const halfScored = {
      title: 'Half scored',
      project_id: testProjectId,
      created_by: 'test-user',
      wsjf: { value: 8 },
    };

    const result = CreateTaskClientSchema.safeParse(halfScored);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      // The three missing components are flagged.
      expect(paths).toContain('wsjf.timeCriticality');
      expect(paths).toContain('wsjf.riskOpportunity');
      expect(paths).toContain('wsjf.jobSize');
    }

    // UpdateTaskClientSchema enforces the same rule.
    const updResult = UpdateTaskClientSchema.safeParse({ wsjf: { value: 8 } });
    expect(updResult.success).toBe(false);

    // A full WSJF payload passes the client schema.
    const ok = CreateTaskClientSchema.safeParse({
      title: 'Full scored',
      project_id: testProjectId,
      created_by: 'test-user',
      wsjf: fullWsjf,
    });
    expect(ok.success).toBe(true);
  });

  it('AC3: an unscored task is unaffected (all wsjf_* fields read back null)', () => {
    const created = taskRepo.create(baseDto());
    const read = taskRepo.findById(created.id)!;

    expect(read.wsjf_value).toBeNull();
    expect(read.wsjf_time_criticality).toBeNull();
    expect(read.wsjf_risk_opportunity).toBeNull();
    expect(read.wsjf_job_size).toBeNull();
    expect(read.wsjf_evidence).toBeNull();
    expect(read.wsjf_locked).toBeNull();
    expect(read.wsjf_source).toBeNull();
    expect(read.wsjf_classifications).toBeNull();
    expect(read.wsjf_features).toBeNull();
  });

  it('update sets a WSJF score on a previously-unscored task', () => {
    const created = taskRepo.create(baseDto());
    const updated = taskRepo.update(created.id, { wsjf: fullWsjf });

    expect(updated.wsjf_value).toBe(8);
    expect(updated.wsjf_job_size).toBe(2);
    expect(updated.wsjf_evidence).toEqual(fullWsjf.evidence);
  });

  it('update with wsjf: null clears all components back to unscored', () => {
    const created = taskRepo.create(baseDto({ wsjf: fullWsjf }));
    const cleared = taskRepo.update(created.id, { wsjf: null });

    expect(cleared.wsjf_value).toBeNull();
    expect(cleared.wsjf_time_criticality).toBeNull();
    expect(cleared.wsjf_risk_opportunity).toBeNull();
    expect(cleared.wsjf_job_size).toBeNull();
    expect(cleared.wsjf_evidence).toBeNull();
    expect(cleared.wsjf_locked).toBeNull();
  });

  it('update without wsjf leaves an existing score untouched', () => {
    const created = taskRepo.create(baseDto({ wsjf: fullWsjf }));
    const updated = taskRepo.update(created.id, { title: 'renamed' });

    expect(updated.title).toBe('renamed');
    expect(updated.wsjf_value).toBe(8);
    expect(updated.wsjf_evidence).toEqual(fullWsjf.evidence);
  });
});
