/**
 * Task 5 (project "Configurable Task Models") — model-policy.service.
 *
 * The single owner of the WSJF-jobSize → power-category bijection and the
 * SINGLE-LAYER model resolver.
 *
 * `categoryForJobSize` is a strict 1:1 relabel of the Fibonacci jobSize tiers
 * {1,2,3,5,8,13} → the six {@link PowerCategory} values, ascending by power.
 * Any off-scale or absent jobSize maps to `null`.
 *
 * `resolveModel` is SINGLE-LAYER: it consults the project policy if one is
 * configured, otherwise the global policy — it does NOT merge the two layers
 * per slot. The two-layer per-slot merge is a separate downstream task (#915);
 * do not add it here.
 *
 * Within the chosen layer, resolution for a role is:
 *   1. If the task is scored and the role has a `byCategory` entry for that
 *      task's category → that model.
 *   2. Else the role `default`.
 *   3. The `planning` role uses its `constant` instead of category routing.
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
 *   `resolveModel` (single-layer resolve).
 */
export function createModelPolicyService(deps: ModelPolicyDeps) {
  const categoryForJobSize = (jobSize: number | null | undefined): PowerCategory | null =>
    jobSize == null ? null : (FIB_TO_CATEGORY[jobSize] ?? null);

  const toResolved = (ref: string | undefined): ResolvedModel =>
    ref == null ? null : ref === 'auto' ? { model: 'auto' } : { model: ref };

  /**
   * Resolve a single role within a SINGLE layer. The project layer wins when
   * the project configures any policy at all; otherwise the global layer is
   * used. No per-slot cross-layer merge (that is task #915).
   */
  const resolveModel = (projectId: number, role: PipelineRole, taskId?: number): ResolvedModel => {
    // Single-layer selection: project policy if present, else global.
    const policy: ModelPolicy | null = deps.getProjectPolicy(projectId) ?? deps.getGlobalPolicy();
    const rolePolicy = policy?.[role] as RolePolicy | undefined;
    if (rolePolicy == null) return null;

    // The planning role is category-agnostic: it pins a single constant.
    if (role === 'planning') {
      return toResolved(rolePolicy.constant ?? rolePolicy.default);
    }

    // Category routing for a scored task, else the role default.
    const category = taskId != null ? categoryForJobSize(deps.getJobSize(taskId)) : null;
    const byCat = category != null ? rolePolicy.byCategory?.[category] : undefined;
    return toResolved(byCat ?? rolePolicy.default);
  };

  return { categoryForJobSize, resolveModel };
}

/** Public type of a constructed model-policy service. */
export type ModelPolicyService = ReturnType<typeof createModelPolicyService>;
