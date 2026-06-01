import { z } from 'zod';

/**
 * WSJF (Phase 3.1): the modified Fibonacci scale {1,2,3,5,8,13} used for
 * value-theme weights (and, elsewhere, for every WSJF component score).
 *
 * Implemented as a union of literals rather than `z.number()` with a refine
 * so the boundary rejects off-scale integers (4, 6, 7, ...) with a clear
 * enum error instead of a generic predicate failure. The runtime set is
 * kept in lockstep with `Fib` in `src/types/task.ts`.
 */
export const FibSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);
export type FibInput = z.infer<typeof FibSchema>;

/**
 * One ranked value theme within a project's charter. The `weight` must be a
 * Fibonacci tier — a non-Fibonacci weight (e.g. 4) is rejected here.
 */
export const ValueThemeSchema = z.object({
  name: z.string().min(1).max(200),
  weight: FibSchema,
  description: z.string().max(2000),
});
export type ValueThemeInput = z.infer<typeof ValueThemeSchema>;

/**
 * The per-project "value charter" persisted in `projects.value_charter`
 * (migration 014). Validated at the service boundary on write; the
 * repository trusts the stored bytes on read (parse-only).
 *
 * The whole charter is nullable at the project level — see
 * `ValueCharterNullableSchema`, which is what the create/update DTO wires in.
 */
export const ValueCharterSchema = z.object({
  mission: z.string().min(1).max(5000),
  value_themes: z.array(ValueThemeSchema).max(20),
  time_context: z.string().max(5000),
  risk_posture: z.string().max(5000),
  out_of_scope: z.array(z.string().max(500)).max(50),
  interview_version: z.number().int().nonnegative(),
  updated_at: z.string().min(1),
});
export type ValueCharterInput = z.infer<typeof ValueCharterSchema>;

/**
 * The charter as it rides on create/update DTOs: a full charter, an explicit
 * `null` (clear), or absent (`undefined`, leave untouched). Mirrors the
 * `CreateProjectDTO.value_charter` field in `src/types/task.ts`.
 */
export const ValueCharterNullableSchema = ValueCharterSchema.nullable();

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  value_charter: ValueCharterNullableSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  value_charter: ValueCharterNullableSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;
