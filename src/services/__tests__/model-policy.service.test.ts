import { describe, expect, it } from 'vitest';
import type { ModelPolicy } from '../../schemas/model-policy.schema.js';
import { createModelPolicyService } from '../model-policy.service.js';
import { NotFoundError, ValidationError } from '../errors.js';

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
  projectExists: () => true,
  getProjectPolicy: () => project,
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
      projectExists: () => false,
      getProjectPolicy: () => null,
      getGlobalPolicy: () => ({ execution: { default: 'glob-default' } }),
      getTask: () => null,
    });
    expect(() => s.resolveModel(999, 'execution')).toThrow(NotFoundError);
    expect(() => s.resolveModel(999, 'execution')).toThrow('Project with id 999 not found');
  });

  it('throws NotFoundError for a nonexistent task (no silent default-merge routing)', () => {
    const s = createModelPolicyService({
      projectExists: () => true,
      getProjectPolicy: () => ({ execution: { default: 'proj-default' } }),
      getGlobalPolicy: () => null,
      getTask: () => null, // no such task
    });
    expect(() => s.resolveModel(1, 'execution', 404404)).toThrow(NotFoundError);
    expect(() => s.resolveModel(1, 'execution', 404404)).toThrow('Task with id 404404 not found');
  });

  it('throws ValidationError when the task belongs to a different project (no foreign jobSize routing)', () => {
    const s = createModelPolicyService({
      projectExists: () => true,
      getProjectPolicy: () => ({ execution: { byCategory: { heavy: 'h' }, default: 'd' } }),
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
      projectExists: () => true,
      getProjectPolicy: () => ({ execution: { default: 'd' } }),
      getGlobalPolicy: () => null,
      getTask: () => {
        throw new Error('getTask must not be called without a taskId');
      },
    });
    expect(s.resolveModel(1, 'execution')).toEqual({ model: 'd' });
  });
});
