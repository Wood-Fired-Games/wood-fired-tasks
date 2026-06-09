import { describe, expect, it } from 'vitest';
import type { ModelPolicy } from '../../schemas/model-policy.schema.js';
import { createModelPolicyService } from '../model-policy.service.js';

/**
 * Build a service with fully fake, injected deps. `project`/`global` are the
 * two policy layers (either may be `null`); `jobSizeByTask` maps taskId → its
 * WSJF Fibonacci jobSize (absent ⇒ unscored ⇒ `null`).
 */
const fakeDeps = (
  project: ModelPolicy | null,
  global: ModelPolicy | null,
  jobSizeByTask: Record<number, number | null> = {},
) => ({
  getProjectPolicy: () => project,
  getGlobalPolicy: () => global,
  getJobSize: (taskId: number) => jobSizeByTask[taskId] ?? null,
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

    it('uses the planning constant even for a scored task (no category routing)', () => {
      const s = createModelPolicyService(
        fakeDeps(
          { planning: { constant: 'pin', byCategory: { heavy: 'should-be-ignored' } } },
          null,
          { 7: 8 },
        ),
      );
      expect(s.resolveModel(1, 'planning', 7)).toEqual({ model: 'pin' });
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
