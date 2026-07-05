import { z } from 'zod';

/**
 * Zod schemas for the `/tasks:audit` skill (Wave 7.1 / wood-fired-tasks
 * task #323).
 *
 * Contract source of truth: `docs/tasks-audit-design.md`. This module
 * is the in-tree TypeScript mirror — it MUST stay field-for-field
 * aligned with the design doc's §4 (AUDIT.md frontmatter table) so
 * callers that prefer a typed validator have an authoritative drop-in.
 *
 * Wave 7.1 (#323) decision: the orchestrator is NOT implemented in this
 * commit. The schema therefore exists today as:
 *
 *   1. A regression gate for the design doc (any drift between schema
 *      and the §4 table surfaces in the schema tests).
 *   2. A typed entry point for the future runtime — when the
 *      orchestrator lands, it will hand-author AUDIT.md frontmatter
 *      directly via the Write tool (same pattern as
 *      `skills/tasks/loop.md` Step 9 for LOOP-RUN.md) and parse it
 *      back via these schemas to drive the $5 cost-cap check.
 *
 * Runtime-vs-schema split (important):
 *
 *   - Zod CAN enforce: required fields, types, value ranges (e.g.
 *     non-negative integer counts, UUID format for `run_id` /
 *     `audit_id`, enum membership for `score` /
 *     `integration_verdict`).
 *   - Zod CANNOT enforce: the count invariant
 *     `covered_count + partial_count + missing_count == total_tasks`
 *     (the audit pipeline MUST construct counts so this holds — same
 *     posture as `LoopRunFrontmatterSchema`'s `tasks_attempted` sum;
 *     see `docs/loop-run-schema.md` §3), the $5 hard cost cap
 *     (Step 3 runtime logic; guardrail 3), the read-only constraint
 *     on the source tree (guardrail 1), or the read-only constraint
 *     on the bugs DB (guardrail 2). Those guardrails are enforced
 *     by the orchestrator and locked in by static gates in
 *     `src/api/routes/tasks/__tests__/skill-audit-design.test.ts`.
 */

/**
 * Per-task audit score. Derived from the verifier's top-level
 * `verdict` in `docs/verifier-contract.md`:
 *
 *   PASS         → COVERED
 *   PARTIAL      → PARTIAL
 *   NOT_VERIFIED → PARTIAL
 *   FAIL         → MISSING
 *
 * See `docs/tasks-audit-design.md` §3 Step 4 for the mapping table.
 */
export const AuditScoreSchema = z.enum(['COVERED', 'PARTIAL', 'MISSING']);
export type AuditScore = z.infer<typeof AuditScoreSchema>;

/**
 * Integration-level verdict, rolled up from per-task `AuditScore`
 * values per the table in `docs/tasks-audit-design.md` §3 Step 5:
 *
 *   any MISSING            → MISSING
 *   any PARTIAL (no MISS.) → PARTIAL
 *   all COVERED            → COVERED
 *
 * Uses the same three-value enum as `AuditScoreSchema` — the audit
 * roll-up is intentionally symmetric with the per-task score so the
 * AUDIT.md body and frontmatter stay readable side-by-side.
 */
export const IntegrationVerdictSchema = AuditScoreSchema;
export type IntegrationVerdict = z.infer<typeof IntegrationVerdictSchema>;

/**
 * Mirrors the verifier's top-level `verdict` enum from
 * `docs/verifier-contract.md`. Stored verbatim on each
 * `AuditTaskEntry` so the AUDIT.md `## Per-Task Audit` body can show
 * both the raw verifier verdict AND the audit score derived from it
 * (useful when reviewing why a `NOT_VERIFIED` rolled up to `PARTIAL`).
 */
export const VerifierVerdictSchema = z.enum(['PASS', 'FAIL', 'PARTIAL', 'NOT_VERIFIED']);
export type VerifierVerdict = z.infer<typeof VerifierVerdictSchema>;

/**
 * Frontmatter for the `AUDIT.md` artifact emitted by Step 6 of
 * `/tasks:audit`. Lives at
 * `.planning/loops/<UTC>-<project_id>-AUDIT.md` (gitignored —
 * `.planning/` is in `.gitignore`, same rationale as `LOOP-RUN.md`;
 * see `docs/tasks-audit-design.md` §4).
 *
 * `run_id` is the LOOP-RUN.md's id (correlates the two artifacts).
 * `audit_id` is fresh per audit invocation (idempotency key for
 * re-runs; the orchestrator MAY dedup by `audit_id`).
 */
export const AuditRunFrontmatterSchema = z.object({
  run_id: z.string().uuid(),
  audit_id: z.string().uuid(),
  project_id: z.number().int().positive(),
  audit_started_at: z.string().datetime(),
  audit_ended_at: z.string().datetime(),
  total_tasks: z.number().int().nonnegative(),
  covered_count: z.number().int().nonnegative(),
  partial_count: z.number().int().nonnegative(),
  missing_count: z.number().int().nonnegative(),
  integration_verdict: IntegrationVerdictSchema,
  total_usd: z.number().nonnegative(),
  cost_cap_hit: z.boolean(),
});
export type AuditRunFrontmatter = z.infer<typeof AuditRunFrontmatterSchema>;

/**
 * One row in the AUDIT.md `## Per-Task Audit` table. The audit
 * orchestrator builds one of these per task in LOOP-RUN.md's
 * `## Tasks Closed` list.
 *
 * `verifier_verdict` is the verbatim verdict returned by the
 * `tasks-verifier` subagent (per `docs/verifier-contract.md`). `score`
 * is the audit-side derivation per §3 Step 4 of the design.
 *
 * `first_failing_evidence` is OPTIONAL — present only when at least
 * one check came back `FAIL` or `SKIP`. The orchestrator truncates the
 * `evidence_url_or_text` from the verifier output to 200 chars so the
 * AUDIT.md body stays readable.
 *
 * `no_acceptance_criteria` is OPTIONAL and set `true` when Step 2 of
 * the pipeline could neither read an `acceptance_criteria` column nor
 * reconstruct bullets from the description — the verifier was NOT
 * dispatched, and `score` is `PARTIAL` by definition.
 */
export const AuditTaskEntrySchema = z.object({
  task_id: z.number().int().positive(),
  title: z.string().min(1),
  score: AuditScoreSchema,
  verifier_verdict: VerifierVerdictSchema.optional(),
  check_count: z.number().int().nonnegative(),
  first_failing_evidence: z.string().max(200).optional(),
  no_acceptance_criteria: z.boolean().optional(),
  /** The verdict the original loop run recorded for this task (from LOOP-RUN.md ## Tasks Closed). Drift vs `score` is the audit's key signal. */
  loop_verdict: VerifierVerdictSchema.optional(),
  /** True when the 5 USD cap stopped grading before this task's verifier dispatched. */
  cost_cap_deferred: z.boolean().optional(),
});
export type AuditTaskEntry = z.infer<typeof AuditTaskEntrySchema>;

/**
 * Roll-up envelope: frontmatter + the per-task entries the audit
 * pipeline scored. Round-trip target for callers that want to
 * serialise the AUDIT.md body in JSON-friendly form (the
 * markdown body is the canonical artifact; this envelope is for
 * tooling).
 */
export const AuditRunSchema = z.object({
  frontmatter: AuditRunFrontmatterSchema,
  tasks: z.array(AuditTaskEntrySchema),
});
export type AuditRun = z.infer<typeof AuditRunSchema>;
