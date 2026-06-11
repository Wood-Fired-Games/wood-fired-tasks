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
 * INPUT VALIDATION (task #928 — PR #55 review follow-up): `resolveModel`
 * errors LOUDLY instead of silently mis-routing:
 *   - a nonexistent `projectId` throws `NotFoundError('Project', …)` — without
 *     this guard a bad id silently resolved against the global default (the
 *     REST route 404'd but the stdio MCP tool did not: a transport parity gap);
 *   - a nonexistent `taskId` throws `NotFoundError('Task', …)`;
 *   - a `taskId` belonging to a DIFFERENT project throws `ValidationError` —
 *     otherwise the foreign task's jobSize would size-route the wrong project.
 * Both transports (REST route + stdio MCP tool) and the remote MCP proxy
 * (which forwards to REST) share this single guard because they all wire the
 * SAME service.
 *
 * All policy/project/task lookups are injected so the unit tests run
 * hermetically with fake deps — no DB or network access.
 */

import type {
  ModelPolicy,
  PipelineRole,
  PowerCategory,
  RolePolicy,
} from '../schemas/model-policy.schema.js';
import {
  FAMILY_LADDER,
  type ModelCatalogEntry,
  type ModelFamily,
} from './model-catalog.service.js';
import { NotFoundError, ValidationError } from './errors.js';

/**
 * The role triple is single-sourced in `model-policy.schema.ts` (task #929);
 * re-exported here so existing service-level importers keep working.
 */
export type { PipelineRole } from '../schemas/model-policy.schema.js';

/** Resolver result: a concrete model, the `auto` sentinel, or `null` (inherit). */
export type ResolvedModel = { model: string } | { model: 'auto' } | null;

/**
 * The task facts the resolver validates against: which project the task
 * belongs to, plus its WSJF jobSize tier (`null` when unscored).
 */
export interface ResolverTask {
  project_id: number;
  wsjf_job_size: number | null;
}

/**
 * The project facts the resolver needs: the row's parsed model policy
 * (`null` when the project configures none). Returned from ONE shared fetch
 * (task #931) that doubles as the task-#928 existence guard — a `null`
 * RESULT means "no such project", a `null` POLICY means "project exists,
 * no policy".
 */
export interface ResolverProject {
  model_policy: ModelPolicy | null;
}

/** Injectable dependencies for {@link createModelPolicyService}. */
export interface ModelPolicyDeps {
  /**
   * ONE shared project fetch (task #931): `null` when no such project exists
   * (the task-#928 existence guard), otherwise the project's policy facts.
   * Replaces the former `projectExists` + `getProjectPolicy` pair, which
   * fetched + inflated the same row twice per `resolveModel` call.
   */
  getProject: (projectId: number) => ResolverProject | null;
  /** The global model policy, or `null` when none is configured. */
  getGlobalPolicy: () => ModelPolicy | null;
  /**
   * The task's project membership + WSJF jobSize Fibonacci tier, or `null`
   * when no such task exists (task #928: replaces the bare `getJobSize`
   * lookup so the resolver can validate existence + project membership).
   */
  getTask: (taskId: number) => ResolverTask | null;
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
 * The canonical Default Model Map (task #929 — PR #55 review follow-up).
 * Previously prose-only in `skills/tasks/loop-shared.md` §R; this constant is
 * now THE source `resolveAuto` routes against. Per power category, the model
 * FAMILY each role's `auto` slot should resolve to; `planning` carries no
 * category, so it is a single constant family.
 *
 * Grounded in loop telemetry (2026-06-09 runs): sonnet is the execution floor;
 * validation sits one notch below execution at the bottom and converges at the
 * top; fable is reserved for `maximum` horizons; planning is one dispatch with
 * project-wide blast radius (cost-insensitive) → opus.
 */
export const DEFAULT_MODEL_MAP: {
  byCategory: Record<PowerCategory, { execution: ModelFamily; validation: ModelFamily }>;
  planning: ModelFamily;
} = {
  byCategory: {
    minimal: { execution: 'sonnet', validation: 'haiku' },
    light: { execution: 'sonnet', validation: 'haiku' },
    moderate: { execution: 'sonnet', validation: 'sonnet' },
    strong: { execution: 'sonnet', validation: 'sonnet' },
    heavy: { execution: 'opus', validation: 'opus' },
    maximum: { execution: 'fable', validation: 'opus' },
  },
  planning: 'opus',
};

/**
 * Deterministically resolve an `auto` slot to a concrete catalog model id
 * (task #929): code-level replacement for the per-orchestrator §R prose table
 * lookup in `skills/tasks/loop-shared.md`.
 *
 * Semantics (verbatim from §R):
 *   1. Map (category, role) → family via {@link DEFAULT_MODEL_MAP}; `planning`
 *      uses the single planning constant; a `null` category (unscored task)
 *      uses the `moderate, strong` row.
 *   2. Pick the FIRST catalog entry of that family — the catalog is ordered
 *      newest-power-first, so the first match is the newest of that family.
 *   3. If the family is absent, step DOWN the {@link FAMILY_LADDER}
 *      (fable → opus → sonnet → haiku) to the nearest family present.
 *   4. Ultimate fallback: the first catalog entry; `null` on an empty catalog.
 */
export function resolveAuto(
  catalog: ModelCatalogEntry[],
  category: PowerCategory | null,
  role: PipelineRole,
): string | null {
  const family =
    role === 'planning'
      ? DEFAULT_MODEL_MAP.planning
      : DEFAULT_MODEL_MAP.byCategory[category ?? 'moderate'][role];
  for (const candidate of FAMILY_LADDER.slice(FAMILY_LADDER.indexOf(family))) {
    const match = catalog.find((m) => m.family === candidate);
    if (match != null) return match.id;
  }
  return catalog[0]?.id ?? null;
}

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
   *
   * Validates loudly (task #928): throws `NotFoundError` for a nonexistent
   * project or task, and `ValidationError` when `taskId` names a task that
   * belongs to a different project than `projectId`.
   */
  const resolveModel = (projectId: number, role: PipelineRole, taskId?: number): ResolvedModel => {
    // Existence guard (task #928): a nonexistent project must error, not
    // silently resolve against the global default. Mirrors the REST route's
    // 404 so every transport behaves identically. ONE shared fetch (task
    // #931): the same row also carries the project policy used below.
    const project = deps.getProject(projectId);
    if (project == null) {
      throw new NotFoundError('Project', projectId);
    }

    // Task guard (task #928): a nonexistent task — or one belonging to a
    // DIFFERENT project — must error rather than silently size-routing via
    // the merged default or the foreign task's jobSize.
    let task: ResolverTask | null = null;
    if (taskId != null) {
      task = deps.getTask(taskId);
      if (task == null) {
        throw new NotFoundError('Task', taskId);
      }
      if (task.project_id !== projectId) {
        throw new ValidationError({
          task_id: [
            `Task ${taskId} belongs to project ${task.project_id}, not project ${projectId}`,
          ],
        });
      }
    }

    const projectRole = project.model_policy?.[role] as RolePolicy | undefined;
    const globalRole = deps.getGlobalPolicy()?.[role] as RolePolicy | undefined;

    // One uniform slot walk for every role: byCategory (task-scoped) →
    // constant → default → null, each slot per-slot-merged project ?? global.
    // Planning dispatches normally omit task_id, so byCategory falls through
    // to constant — but a category-routed planning policy (or a constant on
    // execution/validation) is honored exactly as the schema admits it.
    const category = task != null ? categoryForJobSize(task.wsjf_job_size) : null;
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
