import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelPolicy } from '../../schemas/model-policy.schema.js';
import type { ModelCatalogEntry } from '../model-catalog.service.js';
import {
  createModelPolicyService,
  DEFAULT_MODEL_MAP,
  resolveAuto,
} from '../model-policy.service.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { ProjectRepository } from '../../repositories/project.repository.js';
import { TaskRepository } from '../../repositories/task.repository.js';
import { WsjfHistoryRepository } from '../../repositories/wsjf-history.repository.js';
import { createSettingsRepository } from '../../repositories/settings.repository.js';
import { createSettingsService } from '../settings.service.js';
import { TaskService } from '../task.service.js';

/**
 * Build a service with fully fake, injected deps. `project`/`global` are the
 * two policy layers (either may be `null`); `jobSizeByTask` maps taskId → its
 * WSJF Fibonacci jobSize (absent ⇒ unscored ⇒ `null`). Every project exists
 * and every task belongs to project 1 (the projectId all the happy-path tests
 * resolve against) — the task-#928 validation error paths are exercised by
 * their own dedicated deps below.
 */
const fakeDeps = (
  project: ModelPolicy | null,
  global: ModelPolicy | null,
  jobSizeByTask: Record<number, number | null> = {},
) => ({
  // Task #931: ONE shared project fetch — existence + policy in a single dep.
  getProject: () => ({ model_policy: project }),
  getGlobalPolicy: () => global,
  getTask: (taskId: number) => ({ project_id: 1, wsjf_job_size: jobSizeByTask[taskId] ?? null }),
});

describe('categoryForJobSize', () => {
  it('maps the six Fibonacci tiers in order', () => {
    const s = createModelPolicyService(fakeDeps(null, null));
    expect([1, 2, 3, 5, 8, 13].map((f) => s.categoryForJobSize(f))).toEqual([
      'minimal',
      'light',
      'moderate',
      'strong',
      'heavy',
      'maximum',
    ]);
  });

  it('returns null for off-scale and absent jobSize', () => {
    const s = createModelPolicyService(fakeDeps(null, null));
    expect(s.categoryForJobSize(4)).toBeNull();
    expect(s.categoryForJobSize(null)).toBeNull();
    expect(s.categoryForJobSize(undefined)).toBeNull();
    expect(s.categoryForJobSize(0)).toBeNull();
    expect(s.categoryForJobSize(99)).toBeNull();
  });
});

describe('resolveModel — within a single layer', () => {
  it('returns the project byCategory model for a scored task', () => {
    const s = createModelPolicyService(
      fakeDeps({ execution: { byCategory: { heavy: 'claude-opus-4-8' } } }, null, { 7: 8 }),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'claude-opus-4-8' });
  });

  it('falls back to role default when the task is unscored', () => {
    const s = createModelPolicyService(
      fakeDeps({ execution: { byCategory: { heavy: 'x' }, default: 'auto' } }, null, { 7: null }),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'auto' });
  });

  it('falls back to role default when no byCategory entry matches the task category', () => {
    const s = createModelPolicyService(
      // task category is `minimal` (jobSize 1) but only `heavy` is mapped.
      fakeDeps({ execution: { byCategory: { heavy: 'h' }, default: 'd' } }, null, { 7: 1 }),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'd' });
  });

  it('uses the global default when the project has no policy', () => {
    const s = createModelPolicyService(
      fakeDeps(null, { validation: { default: 'claude-sonnet-4-6' } }),
    );
    expect(s.resolveModel(1, 'validation', 9)).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('uses the global byCategory hit for a scored task when the project has no policy', () => {
    const s = createModelPolicyService(
      fakeDeps(null, { execution: { byCategory: { strong: 'glob-strong' } } }, { 9: 5 }),
    );
    expect(s.resolveModel(1, 'execution', 9)).toEqual({ model: 'glob-strong' });
  });

  it('inherits the global role when the project configures a different role', () => {
    const s = createModelPolicyService(
      // project policy present but has nothing for `validation`; global does.
      // two-layer per-slot ⇒ the unset project `validation` slots inherit global.
      fakeDeps({ execution: { default: 'proj-exec' } }, { validation: { default: 'glob-val' } }),
    );
    expect(s.resolveModel(1, 'validation', 9)).toEqual({ model: 'glob-val' });
  });

  it('returns null when neither layer sets anything', () => {
    const s = createModelPolicyService(fakeDeps(null, null));
    expect(s.resolveModel(1, 'execution', 9)).toBeNull();
  });

  it('returns null for a role the chosen layer does not configure', () => {
    const s = createModelPolicyService(fakeDeps(null, { execution: { default: 'x' } }));
    expect(s.resolveModel(1, 'validation', 9)).toBeNull();
  });

  it('resolves the auto sentinel to {model:"auto"}', () => {
    const s = createModelPolicyService(fakeDeps(null, { execution: { default: 'auto' } }));
    expect(s.resolveModel(1, 'execution', 9)).toEqual({ model: 'auto' });
  });

  it('falls back to default when no taskId is supplied (no category)', () => {
    const s = createModelPolicyService(
      fakeDeps({ execution: { byCategory: { heavy: 'h' }, default: 'd' } }, null, { 7: 8 }),
    );
    expect(s.resolveModel(1, 'execution')).toEqual({ model: 'd' });
  });

  describe('planning role', () => {
    it('uses constant for the planning role', () => {
      const s = createModelPolicyService(
        fakeDeps({ planning: { constant: 'claude-opus-4-8' } }, null),
      );
      expect(s.resolveModel(1, 'planning')).toEqual({ model: 'claude-opus-4-8' });
    });

    it('routes a scored planning task through byCategory before the constant (uniform slot walk)', () => {
      const s = createModelPolicyService(
        fakeDeps({ planning: { constant: 'pin', byCategory: { heavy: 'planning-heavy' } } }, null, {
          7: 8,
        }),
      );
      expect(s.resolveModel(1, 'planning', 7)).toEqual({ model: 'planning-heavy' });
    });

    it('uses the planning constant when no task_id is supplied (the normal §R planning dispatch)', () => {
      const s = createModelPolicyService(
        fakeDeps({ planning: { constant: 'pin', byCategory: { heavy: 'planning-heavy' } } }, null, {
          7: 8,
        }),
      );
      expect(s.resolveModel(1, 'planning')).toEqual({ model: 'pin' });
    });

    it('honors a constant on the execution role (byCategory → constant → default)', () => {
      const s = createModelPolicyService(
        fakeDeps({ execution: { constant: 'exec-pin' } }, null, { 7: 8 }),
      );
      // No byCategory entry and no default — the constant must resolve, not null.
      expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'exec-pin' });
      expect(s.resolveModel(1, 'execution')).toEqual({ model: 'exec-pin' });
    });

    it('falls back to the planning default when no constant is set', () => {
      const s = createModelPolicyService(fakeDeps({ planning: { default: 'plan-default' } }, null));
      expect(s.resolveModel(1, 'planning')).toEqual({ model: 'plan-default' });
    });

    it('returns null when planning configures neither constant nor default', () => {
      const s = createModelPolicyService(fakeDeps({ planning: {} }, null));
      expect(s.resolveModel(1, 'planning')).toBeNull();
    });
  });
});

describe('resolveModel — per-slot merge', () => {
  it('prefers the project category over the global category', () => {
    const s = createModelPolicyService(
      fakeDeps(
        { execution: { byCategory: { heavy: 'proj-model' } } },
        { execution: { byCategory: { heavy: 'glob-model' } } },
        { 7: 8 },
      ),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'proj-model' });
  });

  it('inherits an unset project category from the global category', () => {
    const s = createModelPolicyService(
      fakeDeps(
        { execution: { byCategory: { minimal: 'proj-min' } } }, // heavy unset on project
        { execution: { byCategory: { heavy: 'glob-heavy' } } },
        { 7: 8 },
      ),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'glob-heavy' });
  });

  it('merges default independently of byCategory', () => {
    const s = createModelPolicyService(
      fakeDeps(
        { execution: { default: 'proj-default' } },
        { execution: { byCategory: { heavy: 'glob-heavy' } } },
        { 7: 99 }, // off-scale -> no category -> default path
      ),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'proj-default' });
  });

  it('uses project.default over a global byCategory when the task has no category', () => {
    const s = createModelPolicyService(
      fakeDeps(
        { execution: { default: 'proj-default' } },
        { execution: { byCategory: { heavy: 'glob-heavy' }, default: 'glob-default' } },
        // no jobSize for task 7 ⇒ unscored ⇒ no category ⇒ default path
      ),
    );
    expect(s.resolveModel(1, 'execution', 7)).toEqual({ model: 'proj-default' });
  });

  it('per-slot merges the planning constant across layers', () => {
    const s = createModelPolicyService(
      // project planning has only a default; constant inherits from global.
      fakeDeps(
        { planning: { default: 'proj-plan-default' } },
        { planning: { constant: 'glob-plan-const' } },
      ),
    );
    expect(s.resolveModel(1, 'planning')).toEqual({ model: 'glob-plan-const' });
  });
});

describe('resolveModel — input validation (task #928)', () => {
  it('throws NotFoundError for a nonexistent project (no silent global-default resolution)', () => {
    const s = createModelPolicyService({
      getProject: () => null, // no such project
      getGlobalPolicy: () => ({ execution: { default: 'glob-default' } }),
      getTask: () => null,
    });
    expect(() => s.resolveModel(999, 'execution')).toThrow(NotFoundError);
    expect(() => s.resolveModel(999, 'execution')).toThrow('Project with id 999 not found');
  });

  it('throws NotFoundError for a nonexistent task (no silent default-merge routing)', () => {
    const s = createModelPolicyService({
      getProject: () => ({ model_policy: { execution: { default: 'proj-default' } } }),
      getGlobalPolicy: () => null,
      getTask: () => null, // no such task
    });
    expect(() => s.resolveModel(1, 'execution', 404404)).toThrow(NotFoundError);
    expect(() => s.resolveModel(1, 'execution', 404404)).toThrow('Task with id 404404 not found');
  });

  it('throws ValidationError when the task belongs to a different project (no foreign jobSize routing)', () => {
    const s = createModelPolicyService({
      getProject: () => ({
        model_policy: { execution: { byCategory: { heavy: 'h' }, default: 'd' } },
      }),
      getGlobalPolicy: () => null,
      // task 7 exists but lives in project 2, not the requested project 1.
      getTask: () => ({ project_id: 2, wsjf_job_size: 8 }),
    });
    expect(() => s.resolveModel(1, 'execution', 7)).toThrow(ValidationError);
    try {
      s.resolveModel(1, 'execution', 7);
      expect.unreachable('resolveModel must throw for a foreign task');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).fieldErrors).toEqual({
        task_id: ['Task 7 belongs to project 2, not project 1'],
      });
    }
  });

  it('does not consult the task at all when no taskId is supplied', () => {
    const s = createModelPolicyService({
      getProject: () => ({ model_policy: { execution: { default: 'd' } } }),
      getGlobalPolicy: () => null,
      getTask: () => {
        throw new Error('getTask must not be called without a taskId');
      },
    });
    expect(s.resolveModel(1, 'execution')).toEqual({ model: 'd' });
  });
});

describe('resolveAuto — deterministic auto resolution (task #929)', () => {
  /** Catalog factory: newest-power-first entries with explicit families. */
  const entry = (id: string, family: string): ModelCatalogEntry => ({
    id,
    display_name: id,
    family,
    created_at: '',
  });
  const fullCatalog = [
    entry('claude-fable-5', 'fable'),
    entry('claude-opus-4-8', 'opus'),
    entry('claude-sonnet-4-6', 'sonnet'),
    entry('claude-haiku-4-5', 'haiku'),
  ];

  it('routes every category × role per the Default Model Map', () => {
    expect(resolveAuto(fullCatalog, 'minimal', 'execution')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, 'minimal', 'validation')).toBe('claude-haiku-4-5');
    expect(resolveAuto(fullCatalog, 'light', 'execution')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, 'light', 'validation')).toBe('claude-haiku-4-5');
    expect(resolveAuto(fullCatalog, 'moderate', 'execution')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, 'moderate', 'validation')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, 'strong', 'execution')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, 'strong', 'validation')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, 'heavy', 'execution')).toBe('claude-opus-4-8');
    expect(resolveAuto(fullCatalog, 'heavy', 'validation')).toBe('claude-opus-4-8');
    expect(resolveAuto(fullCatalog, 'maximum', 'execution')).toBe('claude-fable-5');
    expect(resolveAuto(fullCatalog, 'maximum', 'validation')).toBe('claude-opus-4-8');
  });

  it('planning resolves to the newest opus regardless of category', () => {
    expect(resolveAuto(fullCatalog, null, 'planning')).toBe('claude-opus-4-8');
    expect(resolveAuto(fullCatalog, 'minimal', 'planning')).toBe('claude-opus-4-8');
    expect(resolveAuto(fullCatalog, 'maximum', 'planning')).toBe('claude-opus-4-8');
  });

  it('a null category (unscored task) uses the moderate/strong row', () => {
    expect(resolveAuto(fullCatalog, null, 'execution')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(fullCatalog, null, 'validation')).toBe('claude-sonnet-4-6');
  });

  it('picks the FIRST catalog entry of the family (newest-power-first order)', () => {
    const catalog = [entry('claude-sonnet-5-0', 'sonnet'), entry('claude-sonnet-4-6', 'sonnet')];
    expect(resolveAuto(catalog, 'moderate', 'execution')).toBe('claude-sonnet-5-0');
  });

  it('steps DOWN the family ladder when the mapped family is absent', () => {
    // maximum/execution maps to fable; no fable in the catalog → opus.
    const noFable = fullCatalog.filter((m) => m.family !== 'fable');
    expect(resolveAuto(noFable, 'maximum', 'execution')).toBe('claude-opus-4-8');
    // ...and with opus also gone, steps down again → sonnet.
    const noFableNoOpus = noFable.filter((m) => m.family !== 'opus');
    expect(resolveAuto(noFableNoOpus, 'maximum', 'execution')).toBe('claude-sonnet-4-6');
    expect(resolveAuto(noFableNoOpus, 'heavy', 'validation')).toBe('claude-sonnet-4-6');
  });

  it('falls back to the first catalog entry when no ladder family below is present', () => {
    // minimal/validation maps to haiku (ladder bottom — nothing below); a
    // catalog with no haiku exercises the ultimate first-entry fallback.
    const catalog = [entry('claude-fable-5', 'fable'), entry('some-future-model', 'future')];
    expect(resolveAuto(catalog, 'minimal', 'validation')).toBe('claude-fable-5');
  });

  it('returns null on an empty catalog', () => {
    expect(resolveAuto([], 'moderate', 'execution')).toBeNull();
    expect(resolveAuto([], null, 'planning')).toBeNull();
  });

  it('DEFAULT_MODEL_MAP is the §R table verbatim', () => {
    expect(DEFAULT_MODEL_MAP).toEqual({
      byCategory: {
        minimal: { execution: 'sonnet', validation: 'haiku' },
        light: { execution: 'sonnet', validation: 'haiku' },
        moderate: { execution: 'sonnet', validation: 'sonnet' },
        strong: { execution: 'sonnet', validation: 'sonnet' },
        heavy: { execution: 'opus', validation: 'opus' },
        maximum: { execution: 'fable', validation: 'opus' },
      },
      planning: 'opus',
    });
  });
});

// ---------------------------------------------------------------------------
// Task #994 — VERIFICATION: a size-only AUTO task (created through
// TaskService.createTask with NO wsjf payload) resolves to a CONCRETE byCategory
// model at EVERY Fibonacci tier 1/2/3/5/8/13 — never null / inherit.
//
// The sizing-guarantee work (#985–#993) made createTask auto-size WSJF-less
// creates: a create with neither a raw `wsjf` payload nor a `wsjf_submission`
// is written through the SIZE-ONLY autoSizeTask path — `wsjf_job_size` =
// minutesToTier(estimated_minutes), `wsjf_source.jobSize='auto'`, and the three
// Cost-of-Delay columns left NULL. That jobSize is exactly what
// model-policy.service routes `byCategory` off, so when a project configures a
// byCategory policy covering all six power categories, every such task MUST
// resolve to a concrete model id for both the execution and validation roles.
//
// minutesToTier thresholds (read from src/services/wsjf.service.ts):
//   <= 15 → 1, <= 30 → 2, <= 60 → 3, <= 240 → 5, <= 960 → 8, > 960 → 13.
// The `estimated_minutes` values below sit squarely inside each band so the
// mapping is unambiguous and the test does not depend on boundary behaviour.
//
// Tasks are created THROUGH TaskService.createTask (real in-memory DB), never
// hand-inserted, so this proves the END-TO-END auto-size → byCategory route.
// ---------------------------------------------------------------------------
describe('size-only auto task routes byCategory at every tier (task #994)', () => {
  let db: Database.Database;
  let taskService: TaskService;
  let projectId: number;
  let projectRepo: ProjectRepository;
  let taskRepo: TaskRepository;

  // A byCategory policy covering ALL SIX power categories, distinct per
  // (category, role) so a wrong route is detectable. Configured on the project
  // layer; the global layer is null so nothing leaks in via the per-slot merge.
  const projectPolicy: ModelPolicy = {
    execution: {
      byCategory: {
        minimal: 'exec-minimal',
        light: 'exec-light',
        moderate: 'exec-moderate',
        strong: 'exec-strong',
        heavy: 'exec-heavy',
        maximum: 'exec-maximum',
      },
    },
    validation: {
      byCategory: {
        minimal: 'val-minimal',
        light: 'val-light',
        moderate: 'val-moderate',
        strong: 'val-strong',
        heavy: 'val-heavy',
        maximum: 'val-maximum',
      },
    },
  };

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
    projectRepo = new ProjectRepository(db);
    taskRepo = new TaskRepository(db);
    const wsjfHistoryRepo = new WsjfHistoryRepository(db);
    // Audit hook wired (db + history repo) so createTask takes the real
    // auto-size-on-create transaction, exactly as production boot does.
    taskService = new TaskService(taskRepo, projectRepo, db, wsjfHistoryRepo);
    projectId = projectRepo.create({ name: 'Sizing Project' }).id;
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Build a resolver whose deps read REAL rows from this test's DB: project
   * existence and policy from the repos, the task's project + jobSize from the
   * actually-created row. Mirrors production wiring — no fakes for the facts
   * under test.
   */
  function resolver() {
    return createModelPolicyService({
      // Task #931: one shared project fetch — existence from the real repo
      // row, the test policy substituted for the matching project id.
      getProject: (id) =>
        projectRepo.findById(id) === null
          ? null
          : { model_policy: id === projectId ? projectPolicy : null },
      getGlobalPolicy: () => null,
      // Task #931: the dedicated resolver-facts fast path, exactly as
      // production wires it in createApp.
      getTask: (taskId) => taskRepo.findResolverFacts(taskId),
    });
  }

  // estimated_minutes chosen mid-band so minutesToTier is unambiguous.
  const TIER_CASES: Array<{ minutes: number; tier: number; category: string }> = [
    { minutes: 10, tier: 1, category: 'minimal' },
    { minutes: 25, tier: 2, category: 'light' },
    { minutes: 45, tier: 3, category: 'moderate' },
    { minutes: 120, tier: 5, category: 'strong' },
    { minutes: 600, tier: 8, category: 'heavy' },
    { minutes: 1500, tier: 13, category: 'maximum' },
  ];

  it.each(
    TIER_CASES,
  )('estimated_minutes=$minutes auto-sizes to tier $tier and resolves byCategory exec+val to concrete models', ({
    minutes,
    tier,
    category,
  }) => {
    // Create through the public service with NO wsjf payload → auto-sized.
    const task = taskService.createTask({
      title: `auto tier ${tier}`,
      project_id: projectId,
      created_by: 'test-agent',
      estimated_minutes: minutes,
    });

    // The create auto-sized to the expected tier with a SIZE-ONLY write:
    // jobSize set, CoD components NULL, source.jobSize='auto'.
    expect(task.wsjf_job_size).toBe(tier);
    expect(task.wsjf_value).toBeNull();
    expect(task.wsjf_time_criticality).toBeNull();
    expect(task.wsjf_risk_opportunity).toBeNull();
    expect(task.wsjf_source?.jobSize).toBe('auto');

    const s = resolver();
    // The bijection relabels the jobSize tier to its power category.
    expect(s.categoryForJobSize(task.wsjf_job_size)).toBe(category);

    // resolve_model returns a CONCRETE byCategory model — never null/inherit —
    // for BOTH the execution and validation roles.
    const exec = s.resolveModel(projectId, 'execution', task.id);
    const val = s.resolveModel(projectId, 'validation', task.id);
    expect(exec).toEqual({ model: `exec-${category}` });
    expect(val).toEqual({ model: `val-${category}` });
    expect(exec).not.toBeNull();
    expect(val).not.toBeNull();
  });

  it('all six tiers resolve to six DISTINCT concrete execution models (no tier collapses to inherit)', () => {
    const resolved = TIER_CASES.map(({ minutes, tier }) => {
      const task = taskService.createTask({
        title: `distinct tier ${tier}`,
        project_id: projectId,
        created_by: 'test-agent',
        estimated_minutes: minutes,
      });
      const s = resolver();
      const exec = s.resolveModel(projectId, 'execution', task.id);
      const val = s.resolveModel(projectId, 'validation', task.id);
      // Neither role ever inherits the session model for an auto-sized task.
      expect(exec).not.toBeNull();
      expect(val).not.toBeNull();
      return (exec as { model: string }).model;
    });
    expect(new Set(resolved).size).toBe(6);
  });

  it('findResolverFacts fast path matches the full findById inflation for a task with tags (task #931)', () => {
    // A scored task WITH tags — the exact shape whose old read path paid for
    // the projects JOIN + tags query + full WSJF inflation just to surface
    // two integers.
    const created = taskRepo.create(
      {
        title: 'fast-path parity',
        status: 'open',
        priority: 'medium',
        project_id: projectId,
        created_by: 'test-agent',
        wsjf: { value: 5, timeCriticality: 3, riskOpportunity: 2, jobSize: 8 },
      },
      ['alpha', 'beta'],
    );
    const full = taskRepo.findById(created.id);
    expect(full?.tags).toEqual(['alpha', 'beta']);
    // The dedicated prepared lookup returns value-identical facts.
    expect(taskRepo.findResolverFacts(created.id)).toEqual({
      project_id: full?.project_id,
      wsjf_job_size: full?.wsjf_job_size,
    });
    expect(taskRepo.findResolverFacts(created.id)).toEqual({
      project_id: projectId,
      wsjf_job_size: 8,
    });

    // Unscored task: wsjf_job_size NULL round-trips as null on both paths.
    const unscored = taskRepo.create(
      {
        title: 'fast-path parity (unscored)',
        status: 'open',
        priority: 'medium',
        project_id: projectId,
        created_by: 'test-agent',
      },
      ['gamma'],
    );
    expect(taskRepo.findResolverFacts(unscored.id)).toEqual({
      project_id: projectId,
      wsjf_job_size: taskRepo.findById(unscored.id)?.wsjf_job_size ?? null,
    });

    // Nonexistent task: null on both paths (the task-#928 existence guard).
    expect(taskRepo.findResolverFacts(999999)).toBeNull();
    expect(taskRepo.findById(999999)).toBeNull();
  });

  it('memoized global policy is invalidated when the default is rewritten (task #931: set → resolve → set new → resolve)', () => {
    // Resolver wired EXACTLY like production createApp: getGlobalPolicy reads
    // through the real (memoizing) settings service over the real repo.
    const settings = createSettingsService(createSettingsRepository(db));
    const s = createModelPolicyService({
      getProject: (id) => (projectRepo.findById(id) == null ? null : { model_policy: null }),
      getGlobalPolicy: () => settings.getModelPolicyDefault(),
      getTask: (taskId) => taskRepo.findResolverFacts(taskId),
    });

    settings.setModelPolicyDefault({ execution: { default: 'first-default' } });
    expect(s.resolveModel(projectId, 'execution')).toEqual({ model: 'first-default' });

    // Rewrite the default → the memo is invalidated → resolve sees the NEW policy.
    settings.setModelPolicyDefault({ execution: { default: 'second-default' } });
    expect(s.resolveModel(projectId, 'execution')).toEqual({ model: 'second-default' });

    // Clearing invalidates too → resolve falls through to null (inherit).
    settings.setModelPolicyDefault(null);
    expect(s.resolveModel(projectId, 'execution')).toBeNull();
  });
});
