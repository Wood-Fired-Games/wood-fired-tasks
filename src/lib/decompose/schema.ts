import { z } from 'zod';

/**
 * Zod schemas for the `/tasks:decompose` skill (Wave 5 / wood-fired-tasks
 * task #320).
 *
 * Contract source of truth: `docs/tasks-decompose-design.md`. This module
 * is the in-tree TypeScript mirror — it MUST stay field-for-field aligned
 * with the design doc's §6 (frontmatter schema) and §7 (candidate task
 * acceptance criteria) so callers that prefer a typed validator have an
 * authoritative drop-in.
 *
 * Wave 5 (#320) decision: the orchestrator is NOT implemented in this
 * commit. The schema therefore exists today as:
 *
 *   1. A regression gate for the design doc (any drift between schema and
 *      the §6 / §7 tables surfaces in the schema tests).
 *   2. A typed entry point for the future runtime — when the orchestrator
 *      lands, it will hand-author DECOMPOSITION.md frontmatter directly via
 *      the Write tool (same pattern as `skills/tasks/loop.md` Step 9 for
 *      LOOP-RUN.md), and parse it back via these schemas to drive the
 *      cost-tracker checkpoint and the `--resume` flag.
 *
 * Runtime-vs-schema split (important):
 *
 *   - Zod CAN enforce: required fields, types, value ranges (e.g. 1 ≤
 *     estimated_minutes ≤ 90), enum membership, success_criteria 3–5,
 *     UUID/datetime formats.
 *   - Zod CANNOT enforce: blast-radius keyword refusal (the goal string is
 *     just `z.string()` at the schema level — the keyword check is Step 1
 *     runtime logic; see `docs/tasks-decompose-design.md` §5 guardrail 4),
 *     interdependence-ratio halts (Step 4 runtime logic; guardrail 3), or
 *     the no-self-rewrite rule (guardrail 2). Those guardrails are
 *     enforced by the orchestrator and locked in by static gates in
 *     `src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`.
 */

/**
 * Domain hint supplied with `--domain`. Drives Step 2 (codebase recon)
 * scope: a `frontend` decomposition Explore-agent walks
 * `src/web/**` first; an `infra` one walks `deploy/**` first; etc.
 * `mixed` is the default and disables the directory-first heuristic.
 */
export const DomainSchema = z.enum([
  'frontend',
  'backend',
  'docs',
  'infra',
  'mixed',
]);
export type Domain = z.infer<typeof DomainSchema>;

/**
 * Topology classifier verdict from the existing `topology_check` MCP tool
 * (Wave 4.1 / task #318). Re-used directly — `/tasks:decompose` does NOT
 * introduce a new topology tool.
 */
export const TopologySchema = z.enum(['FLAT', 'DAG', 'DAG_CYCLIC']);
export type Topology = z.infer<typeof TopologySchema>;

/**
 * Downstream advisory recorded in DECOMPOSITION.md. Maps from `Topology`:
 *   FLAT       → '/tasks:loop'
 *   DAG        → '/tasks:loop-dag'  (Wave 4.3 / task #341)
 *   DAG_CYCLIC → 'BLOCKED'
 * See `docs/tasks-decompose-design.md` §8.
 */
export const AdvisorySchema = z.enum([
  '/tasks:loop',
  '/tasks:loop-dag',
  'BLOCKED',
]);
export type Advisory = z.infer<typeof AdvisorySchema>;

/**
 * When the orchestrator halts early (not happy-path), records WHY in the
 * frontmatter. `cycle`, `high_interdependence`, and `blast_radius_keyword`
 * are the three documented abort branches; `undefined` is the happy path.
 */
export const AbortedReasonSchema = z.enum([
  'cycle',
  'high_interdependence',
  'blast_radius_keyword',
]);
export type AbortedReason = z.infer<typeof AbortedReasonSchema>;

/**
 * Goal length cap. The design caps goals at ~200 words; at ~7.5 chars per
 * English word that is ~1500 chars. We use 1500 as the schema-level upper
 * bound — runtime word-count enforcement is Step 1's job (and surfaces a
 * better error message than the schema's "string too long").
 */
const GOAL_CHAR_LIMIT = 1500;

/**
 * Frontmatter for the `DECOMPOSITION.md` artifact emitted by Step 9 of
 * `/tasks:decompose`. Lives at `.planning/decompositions/<UTC>-<project_id>.md`
 * (gitignored — `.planning/` is in `.gitignore`, same rationale as
 * `LOOP-RUN.md`; see `docs/tasks-decompose-design.md` §6).
 */
export const DecompositionFrontmatterSchema = z.object({
  decomposition_id: z.string().uuid(),
  project_id: z.number().int().positive(),
  generated_at: z.string().datetime(),
  goal: z.string().min(1).max(GOAL_CHAR_LIMIT),
  success_criteria: z.array(z.string().min(1)).min(3).max(5),
  domain: DomainSchema,
  topology: TopologySchema,
  advisory: AdvisorySchema,
  candidate_count: z.number().int().nonnegative(),
  dependency_edge_count: z.number().int().nonnegative(),
  total_usd: z.number().nonnegative(),
  cost_cap_hit: z.boolean(),
  /**
   * Set when the orchestrator halted early. Absent on the happy path —
   * a successful run leaves this undefined so absence-of-field is
   * distinguishable from the explicit branches.
   */
  aborted_reason: AbortedReasonSchema.optional(),
});
export type DecompositionFrontmatter = z.infer<
  typeof DecompositionFrontmatterSchema
>;

/**
 * A suspected dependency edge between two candidate drafts. The planner
 * (Step 3) emits these as hints; Step 4's critic re-derives the
 * authoritative edge set independently.
 */
export const SuspectedEdgeSchema = z.object({
  from_draft_id: z.number().int().positive(),
  to_draft_id: z.number().int().positive(),
});
export type SuspectedEdge = z.infer<typeof SuspectedEdgeSchema>;

/**
 * One candidate task draft. Step 3's planner subagent emits an array of
 * these (8–25 entries per the design). Step 7 enforces
 * `estimated_minutes ≤ 90` at the schema level — over-sized candidates
 * are split before materialization.
 *
 * `description` upper bound: 1000 chars accommodates the documented 2–3
 * sentences. `title` upper bound: 255 chars matches the wood-fired-tasks
 * `tasks.title` column constraint so a materialization round-trip never
 * loses data.
 */
export const CandidateTaskSchema = z.object({
  draft_id: z.number().int().positive(),
  title: z.string().min(1).max(255),
  description: z.string().min(1).max(1000),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  suspected_edges: z.array(SuspectedEdgeSchema),
  estimated_minutes: z.number().int().min(1).max(90),
});
export type CandidateTask = z.infer<typeof CandidateTaskSchema>;
