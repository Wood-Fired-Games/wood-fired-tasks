import { z } from 'zod';

import type {
  WsjfClassification,
  WsjfEvidence,
  WsjfComponents,
  WsjfFeatures,
  WsjfLocks,
  WsjfSource,
} from '../types/wsjf.js';

/**
 * WSJF Zod schemas (Task 1.5) — runtime validation mirroring the Contracts
 * types in `src/types/wsjf.ts`. Field names are kept aligned with those types.
 *
 * Both normal `parse` (throws on invalid) and `safeParse` (returns a discriminated
 * result) usage are supported on every exported schema, as Zod provides them on
 * any schema object.
 *
 * NOTE: `FibSchema` is intentionally re-declared here (not imported from
 * `project.schema.ts`) — Task 1.5's AC requires it exported FROM this module.
 * It mirrors the {1,2,3,5,8,13} semantics of `Fib` in `src/types/wsjf.ts`.
 */

/**
 * The closed modified-Fibonacci tier set {1,2,3,5,8,13} used for every WSJF
 * component score. Implemented as a union of literals (rather than
 * `z.number().refine(...)`) so off-scale integers (4, 6, 7, ...) fail with a
 * clear enum error.
 */
export const FibSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
]);

const AlignmentClassSchema = z.enum(['none', 'weak', 'direct', 'core']);
const SeverityClassSchema = z.enum(['none', 'tech_debt', 'security', 'data_loss', 'compliance']);
const DecayClassSchema = z.enum(['flat', 'slow', 'fast']);

/**
 * Verbatim source spans backing a classification — one non-empty span per WSJF
 * component. Empty strings are rejected (an evidence-less classification is not
 * auditable).
 */
export const WsjfEvidenceSchema = z
  .object({
    value: z.string().min(1, 'evidence.value must be a non-empty span'),
    timeCriticality: z.string().min(1, 'evidence.timeCriticality must be a non-empty span'),
    riskOpportunity: z.string().min(1, 'evidence.riskOpportunity must be a non-empty span'),
    jobSize: z.string().min(1, 'evidence.jobSize must be a non-empty span'),
  })
  .strict() satisfies z.ZodType<WsjfEvidence>;

/** What the LLM emits — never a final number. */
export const WsjfClassificationSchema = z
  .object({
    themeName: z.string().nullable(),
    alignment: AlignmentClassSchema,
    severity: SeverityClassSchema,
    decay: DecayClassSchema.nullable(),
    jobSizeTier: FibSchema,
    evidence: WsjfEvidenceSchema,
  })
  .strict() satisfies z.ZodType<WsjfClassification>;

/** Stored, server-computed component scores — each a Fibonacci tier. */
export const WsjfComponentsSchema = z
  .object({
    value: FibSchema,
    timeCriticality: FibSchema,
    riskOpportunity: FibSchema,
    jobSize: FibSchema,
  })
  .strict() satisfies z.ZodType<WsjfComponents>;

/** Per-component lock flags — locked components survive a rescore. */
export const WsjfLocksSchema = z
  .object({
    value: z.boolean(),
    timeCriticality: z.boolean(),
    riskOpportunity: z.boolean(),
    jobSize: z.boolean(),
  })
  .strict() satisfies z.ZodType<WsjfLocks>;

/** Per-component provenance: server-derived (`auto`) vs human-set (`manual`). */
const SourceFlagSchema = z.enum(['auto', 'manual']);
export const WsjfSourceSchema = z
  .object({
    value: SourceFlagSchema,
    timeCriticality: SourceFlagSchema,
    riskOpportunity: SourceFlagSchema,
    jobSize: SourceFlagSchema,
  })
  .strict() satisfies z.ZodType<WsjfSource>;

/** Deterministic inputs the server gathers (no LLM). */
export const WsjfFeaturesSchema = z
  .object({
    deadlineDate: z.string().nullable(),
    daysUntilDeadline: z.number().nullable(),
    transitiveDependents: z.number(),
    filesTouched: z.number().nullable(),
    charterVersion: z.number().nullable(),
  })
  .strict() satisfies z.ZodType<WsjfFeatures>;

/**
 * The full payload submitted for scoring: the LLM classification plus the
 * deterministic features the server gathered. Mirrors the `ScoreSubmission`
 * validation-gate contract ({ classification, features }) from the plan; the
 * runtime `ScoreSubmission` interface itself lands with Task 1.6.
 */
export const ScoreSubmissionSchema = z
  .object({
    classification: WsjfClassificationSchema,
    features: WsjfFeaturesSchema,
  })
  .strict();

export type FibInput = z.infer<typeof FibSchema>;
export type WsjfEvidenceInput = z.infer<typeof WsjfEvidenceSchema>;
export type WsjfClassificationInput = z.infer<typeof WsjfClassificationSchema>;
export type WsjfComponentsInput = z.infer<typeof WsjfComponentsSchema>;
export type WsjfLocksInput = z.infer<typeof WsjfLocksSchema>;
export type WsjfSourceInput = z.infer<typeof WsjfSourceSchema>;
export type WsjfFeaturesInput = z.infer<typeof WsjfFeaturesSchema>;
export type ScoreSubmissionInput = z.infer<typeof ScoreSubmissionSchema>;
