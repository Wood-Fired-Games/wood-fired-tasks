import { z } from 'zod';

/**
 * Zod schema for the LOOP-RUN.md frontmatter block emitted by `/tasks:loop`
 * (and `/tasks:bug-smash`) at the end of every run.
 *
 * Contract source of truth:
 *   - Markdown contract: `docs/loop-run-schema.md`
 *   - JSON Schema mirror: `docs/loop-run-schema.json`
 *   - Reference example: `docs/loop-run-reference-example.md`
 *
 * This module is the in-tree TypeScript mirror — it MUST stay field-for-field
 * aligned with `docs/loop-run-schema.json` so callers that prefer a typed
 * validator over the JSON-Schema/Ajv path have an authoritative drop-in.
 *
 * Wave 3.1 (task #316) decision: the orchestrator skill hand-writes the
 * frontmatter YAML directly via the `Write` tool — it does NOT shell out to a
 * TypeScript helper at emit time. This schema is therefore primarily a
 * test + future-tooling artifact (regression gate on the reference example,
 * and a typed entry point for any future `scripts/loop-run/emit.ts` CLI).
 *
 * The schema deliberately does NOT enforce the
 * `tasks_attempted == passed + failed + partial + not_verified` invariant
 * documented in `docs/loop-run-schema.md` §3 — that check is the validator
 * tooling's job (replay), not the schema's. See the corresponding test in
 * `__tests__/schema.test.ts`.
 */
export const LoopRunFrontmatterSchema = z.object({
  run_id: z.string().uuid(),
  project_id: z.number().int().positive(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  wall_seconds: z.number().int().nonnegative(),
  orchestrator_session_id: z.string().min(1),
  total_tokens: z.number().int().nonnegative(),
  total_usd: z.number().nonnegative(),
  subagents_dispatched: z.number().int().nonnegative(),
  tasks_attempted: z.number().int().nonnegative(),
  tasks_passed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  tasks_partial: z.number().int().nonnegative(),
  tasks_not_verified: z.number().int().nonnegative(),
});

export type LoopRunFrontmatter = z.infer<typeof LoopRunFrontmatterSchema>;
