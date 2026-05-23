import { z } from 'zod';

/**
 * Zod schema for the INTEGRATION-AUDIT.md artifact emitted by `/tasks:loop`
 * Step 10 when two or more worker subagents modified overlapping files in
 * the same run.
 *
 * Contract source of truth: `skills/tasks/loop.md` Step 10 (the skill prose
 * IS the contract — there is no separate `docs/integration-audit-schema.md`,
 * by design; LOOP-RUN.md got that treatment in Wave 1.5 only because Wave 1
 * had a dedicated spec task).
 *
 * Wave 3.2 (task #317) decision: the orchestrator hand-writes the frontmatter
 * YAML directly via the `Write` tool — it does NOT shell out to a TypeScript
 * helper at emit time. This schema is therefore primarily a test artifact
 * (regression gate on the skill markdown) and a typed entry point for any
 * future `scripts/integration-audit/emit.ts` CLI.
 *
 * Each `IntegrationOverlap` corresponds to one invocation of the
 * `integration-auditor` subagent (defined at `skills/agents/integration-auditor.md`)
 * — the auditor emits exactly this JSON shape as its final message.
 */

/**
 * The three verdicts an integration-auditor can return. The skill defines
 * the deterministic semantics:
 *   - SAFE   — overlap is benign (different functions or disjoint regions).
 *   - RISKY  — touches same logical region; cannot prove broken. Warn, do
 *              NOT mark the run failed.
 *   - BROKEN — composition demonstrably breaks (signature drift, deleted
 *              symbol still referenced, conflicting type annotations).
 *              Triggers task revert from `done` → `in_progress`.
 */
export const IntegrationVerdictSchema = z.enum(['SAFE', 'RISKY', 'BROKEN']);
export type IntegrationVerdict = z.infer<typeof IntegrationVerdictSchema>;

/**
 * One overlap entry — the structured data the integration-auditor emits per
 * (file × two-tasks) overlap, validated against this schema by the orchestrator
 * before being written into INTEGRATION-AUDIT.md.
 */
export const IntegrationOverlapSchema = z.object({
  file_path: z.string().min(1),
  task_ids: z.array(z.number().int().positive()).min(2),
  verdict: IntegrationVerdictSchema,
  rationale: z.string().max(500),
  evidence: z.array(z.string()).min(1),
});
export type IntegrationOverlap = z.infer<typeof IntegrationOverlapSchema>;

/**
 * Frontmatter for INTEGRATION-AUDIT.md.
 *
 * `overlap_count` is `.int().positive()` (≥ 1) because the file is only
 * emitted when at least one overlap exists — the empty-overlap suppression
 * rule from Step 10 is load-bearing UX (don't add noise to .planning/loops/
 * when the loop ran clean).
 *
 * `broken_count`, `risky_count`, and `safe_count` are non-negative ints that
 * must sum to `overlap_count`. The schema does NOT enforce the sum invariant
 * (mirrors the LoopRunFrontmatterSchema convention — sum checks belong in
 * replay tooling, not in the schema, so partial mid-run frontmatter can still
 * parse).
 */
export const IntegrationAuditFrontmatterSchema = z.object({
  run_id: z.string().uuid(),
  project_id: z.number().int().positive(),
  generated_at: z.string().datetime(),
  overlap_count: z.number().int().positive(),
  broken_count: z.number().int().nonnegative(),
  risky_count: z.number().int().nonnegative(),
  safe_count: z.number().int().nonnegative(),
});
export type IntegrationAuditFrontmatter = z.infer<typeof IntegrationAuditFrontmatterSchema>;
