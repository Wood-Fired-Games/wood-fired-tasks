import { z } from 'zod';

/**
 * Six power categories implying how much model power a task warrants. A fixed
 * 1:1 relabel of the WSJF `jobSize` Fibonacci tiers {1,2,3,5,8,13}; the
 * bijection lives in `model-policy.service.ts`. Listed ascending by power.
 */
export const POWER_CATEGORIES = [
  'minimal',
  'light',
  'moderate',
  'strong',
  'heavy',
  'maximum',
] as const;
export const PowerCategorySchema = z.enum(POWER_CATEGORIES);
export type PowerCategory = (typeof POWER_CATEGORIES)[number];

/**
 * The three pipeline dispatch roles a policy can configure (task #929 —
 * PR #55 review follow-up). THE single source of the role triple: every other
 * role-enum site (`ModelPolicySchema` keys, the `resolve_model` tool/route
 * input schemas, the remote rest-client union, the CLI flag roles) derives
 * from these exports — never restate the literals.
 */
export const PIPELINE_ROLES = ['execution', 'validation', 'planning'] as const;
export const PipelineRoleSchema = z.enum(PIPELINE_ROLES);
export type PipelineRole = (typeof PIPELINE_ROLES)[number];

/** A concrete catalog model id, or the `auto` sentinel (resolve at dispatch). */
export const ModelRefSchema = z.union([z.string().min(1).max(200), z.literal('auto')]);
export type ModelRef = z.infer<typeof ModelRefSchema>;

/**
 * Per-category routing table: each of the six categories may map to a
 * `ModelRef`. `.partial()` so a sparse table is valid (only the categories a
 * caller cares about); `.strict()` so an unknown category key is rejected.
 */
const ByCategorySchema = z
  .object({
    minimal: ModelRefSchema,
    light: ModelRefSchema,
    moderate: ModelRefSchema,
    strong: ModelRefSchema,
    heavy: ModelRefSchema,
    maximum: ModelRefSchema,
  })
  .partial()
  .strict();

/** One role's policy: category-routed OR a single constant, plus a default. */
export const RolePolicySchema = z
  .object({
    byCategory: ByCategorySchema.optional(),
    constant: ModelRefSchema.optional(),
    default: ModelRefSchema.optional(),
  })
  .strict();
export type RolePolicy = z.infer<typeof RolePolicySchema>;

/**
 * The full model policy: one `RolePolicy` per dispatch role. `.partial()` so a
 * policy may configure only some roles; `.strict()` so an unknown role key
 * (e.g. `orchestrator`) is rejected at the boundary.
 */
export const ModelPolicySchema = z
  .object({
    execution: RolePolicySchema,
    validation: RolePolicySchema,
    planning: RolePolicySchema,
    // `satisfies` ties these keys to PIPELINE_ROLES at compile time: adding or
    // renaming a role without updating the single source is a type error.
  } satisfies Record<PipelineRole, typeof RolePolicySchema>)
  .partial()
  .strict();
export type ModelPolicy = z.infer<typeof ModelPolicySchema>;

/**
 * Nullable variant for write/read paths where `null` means "no policy
 * configured" (clears the column) and round-trips as `null`.
 */
export const ModelPolicyNullableSchema = ModelPolicySchema.nullable();
export type ModelPolicyNullable = z.infer<typeof ModelPolicyNullableSchema>;
