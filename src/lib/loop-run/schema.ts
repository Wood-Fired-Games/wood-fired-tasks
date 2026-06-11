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
  // Best-effort roll-up of available subagent <usage> blocks; NOT authoritative.
  // `null` when unmeasured (orchestrator-session tokens are not captured at emit
  // time, so the total cannot be asserted as exact). Present-but-nullable
  // (`.nullable()`, not `.optional()`): the key MUST be emitted — emit `null`,
  // never omit. Authoritative figure is the post-run agent_transactions_v join.
  total_tokens: z.number().int().nonnegative().nullable(),
  // Best-effort roll-up; `null` when unmeasured (orchestrator-session USD not
  // captured at emit time). Present-but-nullable, same contract as total_tokens.
  total_usd: z.number().nonnegative().nullable(),
  subagents_dispatched: z.number().int().nonnegative(),
  tasks_attempted: z.number().int().nonnegative(),
  tasks_passed: z.number().int().nonnegative(),
  tasks_failed: z.number().int().nonnegative(),
  tasks_partial: z.number().int().nonnegative(),
  tasks_not_verified: z.number().int().nonnegative(),
  /**
   * Wave 4.2 (task #319) — outcome of the §2f topology pre-flight gate.
   * Wave 11 added `auto_ordered` for the auto-resolving DAG branch.
   *
   *   - `allowed`      — topology=FLAT; the loop proceeded with default
   *                      priority + ID ordering.
   *   - `auto_ordered` — topology=DAG (no override flag); the loop computed
   *                      a topological execution order via Kahn's algorithm
   *                      and proceeded. Tie-breaking: priority DESC,
   *                      created_at ASC, id ASC.
   *   - `overridden`   — topology=DAG and the invocation included
   *                      `--i-know-what-im-doing`; the loop skipped the
   *                      topological sort and used the default flat
   *                      ordering, with a loud warning in the first prompt.
   *   - `blocked`      — topology=DAG_CYCLIC (cannot be overridden); the
   *                      loop halted before dispatching any worker. Also
   *                      used by the pre-Wave-11 DAG-without-override
   *                      behaviour, retained for backward compatibility.
   *
   * Optional to preserve backward compatibility with the pre-#319
   * LOOP-RUN.md emissions locked in by task #316's reference example +
   * schema tests. Emissions WITHOUT this field still parse.
   */
  gate_decision: z.enum(['allowed', 'auto_ordered', 'overridden', 'blocked']).optional(),
  /**
   * Configurable task models (project "Configurable Task Models", task #924) —
   * provenance for the per-role model overrides a run forced via the
   * `--execution-model` / `--validation-model` / `--planning-model` run-arg
   * flags (see `skills/tasks/loop-shared.md` §R "Model resolution"). Each field
   * records the concrete model ref (or the literal `auto`) the run pinned for
   * that pipeline role's dispatches; absent fields mean the run used per-project
   * `resolve_model` resolution for that role rather than a forced override.
   *
   * Optional + omitted-when-unset (NOT `.nullable()`): a run with no override
   * for a role emits NOTHING for that key, preserving backward compatibility
   * with every pre-#924 LOOP-RUN.md emission (which never carried these keys).
   */
  execution_model: z.string().min(1).optional(),
  validation_model: z.string().min(1).optional(),
  planning_model: z.string().min(1).optional(),
});

export type LoopRunFrontmatter = z.infer<typeof LoopRunFrontmatterSchema>;
