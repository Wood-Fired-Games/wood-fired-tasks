import { z } from 'zod';
import type { ScmBackendConfigValue, ScmBehaviors } from '../scm/types.js';

/**
 * Pluggable SCM (spec §3.2 / §6.3): the project charter's optional `scm`
 * default. It supplies a backend HINT plus behavior-toggle defaults ONLY as the
 * precedence-2 fallback — a repo with no `.tasks/scm.json` and no on-disk
 * marker. It never overrides an on-disk signal (§3.2).
 *
 * This is the authoritative Zod validator for the `projects.scm` column
 * (migration 017), mirroring how `ModelPolicySchema` owns `projects.model_policy`
 * (migration 016). The repository serializes on write (JSON.stringify) and
 * validates on read (JSON.parse + this schema); the DB column carries no CHECK.
 *
 * The literals / keys are tied to `src/scm/types.ts` at compile time via
 * `satisfies`, so a backend rename or a new behavior toggle there is a type
 * error here until this schema is updated in lockstep.
 */

/** The `backend` hint — the `.tasks/scm.json` `backend` value set (§3.1), incl. `"auto"`. */
export const ScmBackendConfigValueSchema = z.enum([
  'git',
  'perforce',
  'none',
  'auto',
] satisfies ScmBackendConfigValue[]);

/**
 * Behavior toggles (§3.1 `behaviors`). Every toggle is optional — a sparse set
 * is valid (per-backend defaults fill the gaps, §3.3); `.strict()` rejects an
 * unknown toggle key. Keys are tied to {@link ScmBehaviors}.
 */
export const ScmBehaviorsSchema = z
  .object({
    commit: z.boolean(),
    isolate: z.boolean(),
    publish: z.boolean(),
    openReview: z.boolean(),
    branchPerRun: z.boolean(),
  } satisfies Record<keyof ScmBehaviors, z.ZodBoolean>)
  .partial()
  .strict();

/**
 * The project charter's `scm` default: an optional backend hint plus optional
 * behavior toggles. `.strict()` so an unknown top-level key is rejected at the
 * boundary. Both members optional so a charter may pin only a backend, only
 * toggles, or (an empty object) neither.
 */
export const ScmCharterSchema = z
  .object({
    backend: ScmBackendConfigValueSchema.optional(),
    behaviors: ScmBehaviorsSchema.optional(),
  })
  .strict();
export type ScmCharter = z.infer<typeof ScmCharterSchema>;

/**
 * Nullable variant for write/read paths where `null` means "no scm default
 * configured" (clears the column) and round-trips as `null`. Mirrors
 * `ModelPolicyNullableSchema`.
 */
export const ScmCharterNullableSchema = ScmCharterSchema.nullable();
export type ScmCharterNullable = z.infer<typeof ScmCharterNullableSchema>;
