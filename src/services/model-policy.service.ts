/**
 * Task 6 (project "Configurable Task Models") — model-policy.service.
 *
 * The single owner of the WSJF-jobSize → power-category bijection and the
 * TWO-LAYER PER-SLOT model resolver.
 *
 * `categoryForJobSize` is a strict 1:1 relabel of the Fibonacci jobSize tiers
 * {1,2,3,5,8,13} → the six {@link PowerCategory} values, ascending by power.
 * Any off-scale or absent jobSize maps to `null`.
 *
 * `resolveModel` performs a TWO-LAYER PER-SLOT MERGE: for the requested role,
 * each slot — the task category's `byCategory` entry, the `constant`, and the
 * `default` — is resolved INDEPENDENTLY as `project[role][slot] ?? global[role][slot]`.
 * So an unset project slot inherits the corresponding global slot (cross-layer);
 * the project layer is NOT taken wholesale.
 *
 * Within the merged role, resolution precedence is:
 *   1. If the task is scored and the merged `byCategory` has an entry for that
 *      task's category → that model.
 *   2. Else the merged role `default`.
 *   3. The `planning` role uses its merged `constant` (falling back to merged
 *      `default`) instead of category routing.
 * A resolved `auto` sentinel round-trips as `{ model: 'auto' }`; an absent
 * value yields `null` ("inherit the session model").
 *
 * All policy/jobSize lookups are injected so the unit tests run hermetically
 * with fake deps — no DB or network access.
 */

import type { ModelPolicy, PowerCategory, RolePolicy } from '../schemas/model-policy.schema.js';

/** The three pipeline dispatch roles a policy can configure. */
export type PipelineRole = 'execution' | 'validation' | 'planning';

/** Resolver result: a concrete model, the `auto` sentinel, or `null` (inherit). */
export type ResolvedModel = { model: string } | { model: 'auto' } | null;

/** Injectable dependencies for {@link createModelPolicyService}. */
export interface ModelPolicyDeps {
  /** The project's model policy, or `null` when the project configures none. */
  getProjectPolicy: (projectId: number) => ModelPolicy | null;
  /** The global model policy, or `null` when none is configured. */
  getGlobalPolicy: () => ModelPolicy | null;
  /** The task's WSJF jobSize Fibonacci tier, or `null` when unscored. */
  getJobSize: (taskId: number) => number | null;
}

/**
 * The bijection itself. Fibonacci jobSize tiers in ascending order map 1:1 to
 * the six power categories (also ascending). Keys not present here (e.g. 4)
 * are off-scale and resolve to `null`.
 */
const FIB_TO_CATEGORY: Record<number, PowerCategory> = {
  1: 'minimal',
  2: 'light',
  3: 'moderate',
  5: 'strong',
  8: 'heavy',
  13: 'maximum',
};

/**
 * Create a model-policy service instance with the supplied dependencies.
 *
 * @returns An object exposing `categoryForJobSize` (the bijection) and
 *   `resolveModel` (two-layer per-slot merge resolve).
 */
export function createModelPolicyService(deps: ModelPolicyDeps) {
  const categoryForJobSize = (jobSize: number | null | undefined): PowerCategory | null =>
    jobSize == null ? null : (FIB_TO_CATEGORY[jobSize] ?? null);

  const toResolved = (ref: string | undefined): ResolvedModel =>
    ref == null ? null : ref === 'auto' ? { model: 'auto' } : { model: ref };

  /**
   * Resolve a single role with a TWO-LAYER PER-SLOT MERGE. Each slot is
   * resolved independently as `project ?? global`, so an unset project slot
   * inherits the corresponding global slot rather than discarding the global
   * layer wholesale. Slot precedence within the merged role is
   * byCategory → constant → default → null.
   */
  const resolveModel = (projectId: number, role: PipelineRole, taskId?: number): ResolvedModel => {
    const projectRole = deps.getProjectPolicy(projectId)?.[role] as RolePolicy | undefined;
    const globalRole = deps.getGlobalPolicy()?.[role] as RolePolicy | undefined;

    // One uniform slot walk for every role: byCategory (task-scoped) →
    // constant → default → null, each slot per-slot-merged project ?? global.
    // Planning dispatches normally omit task_id, so byCategory falls through
    // to constant — but a category-routed planning policy (or a constant on
    // execution/validation) is honored exactly as the schema admits it.
    const category = taskId != null ? categoryForJobSize(deps.getJobSize(taskId)) : null;
    const byCat =
      category != null
        ? (projectRole?.byCategory?.[category] ?? globalRole?.byCategory?.[category])
        : undefined;
    const constant = projectRole?.constant ?? globalRole?.constant;
    const dflt = projectRole?.default ?? globalRole?.default;
    return toResolved(byCat ?? constant ?? dflt);
  };

  return { categoryForJobSize, resolveModel };
}

/** Public type of a constructed model-policy service. */
export type ModelPolicyService = ReturnType<typeof createModelPolicyService>;
