// WSJF (Weighted Shortest Job First) — deterministic component functions.
//
// Task #622 (WSJF 1.2): the PURE, deterministic scoring substrate. Every
// function here is side-effect-free (no I/O, no clock, no randomness) so that
// the same inputs always map to the same Fibonacci tier / number. The exact
// piecewise maps are the canonical ones from the plan's §Contracts section —
// see `docs/superpowers/plans/2026-06-01-wsjf-prioritization.md` (Task 1.2 and
// the "Deterministic functions" Contracts block) and the design spec
// `docs/superpowers/specs/2026-06-01-wsjf-prioritization-design.md` (§12
// determinism / scoring).
//
// Types are imported from `../types/wsjf.js` (committed by task #621) and are
// NOT redefined here. `Priority` is local to this module per Contracts.

import type {
  Fib,
  AlignmentClass,
  SeverityClass,
  DecayClass,
  WsjfComponents,
  WsjfComponentKey,
  WsjfClassification,
  WsjfFeatures,
  WsjfSource,
} from '../types/wsjf.js';
import { FIB } from '../types/wsjf.js';
import type { ValueCharter, Task, TaskStatus } from '../types/task.js';
import { ScoreSubmissionSchema, WsjfComponentsSchema } from '../schemas/wsjf.schema.js';
import type { WsjfEvidence } from '../types/wsjf.js';
import type { ITaskRepository } from '../repositories/interfaces.js';
import { MAX_PAGE_LIMIT } from '../types/task.js';
import { TopologyService } from './topology.service.js';
import { DependencyService } from './dependency.service.js';
import { BusinessError } from './errors.js';

/** Task priority levels used for the no-WSJF fallback ordering. */
export type Priority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Cost-of-delay propagation damping factor: a dependent's contribution to its
 * blocker's effective CoD is scaled by γ per hop.
 */
export const PROPAGATION_GAMMA = 0.5;

/**
 * Hard ceiling on propagation: a task's effective CoD can never exceed
 * `base_CoD * PROPAGATION_CAP`, no matter how many dependents pile on.
 */
export const PROPAGATION_CAP = 3;

/**
 * Round a raw number UP to the nearest Fibonacci tier in {@link FIB},
 * clamping to the closed range [1, 13]. Values <= 1 collapse to 1; values
 * above 13 saturate at 13.
 *
 * Canonical: 0→1, 4→5, 6→8, 13→13, 99→13.
 */
export function fibClamp(n: number): Fib {
  for (const tier of FIB) {
    if (n <= tier) return tier;
  }
  return 13;
}

/**
 * Time Criticality from a parsed deadline expressed as whole days remaining.
 * 13 is reserved for due-now/overdue. No charter dependence — purely the
 * days-until-deadline band.
 *
 * Canonical bands:
 *   days <= 0    → 13 (overdue / due today / expired)
 *   1..7         → 8
 *   8..90        → 5
 *   91..180      → 3
 *   181..365     → 2
 *   > 365        → 1
 */
export function tcFromDaysUntil(days: number): Fib {
  if (days <= 0) return 13;
  if (days <= 7) return 8;
  if (days <= 90) return 5;
  if (days <= 180) return 3;
  if (days <= 365) return 2;
  return 1;
}

/**
 * Time Criticality when there is NO hard deadline date — driven by the LLM's
 * decay class. Capped at 5 so a deadline-less task can never out-rank a truly
 * time-boxed one.
 *
 * Canonical: flat→1, slow→3, fast→5.
 */
export function tcFromDecayClass(d: DecayClass): Fib {
  switch (d) {
    case 'flat':
      return 1;
    case 'slow':
      return 3;
    case 'fast':
      return 5;
  }
}

/**
 * Risk/Reduction-of-opportunity contribution from DAG fan-out — the number of
 * transitive dependents a task unblocks.
 *
 * Canonical bands: 0→1, 1→3, 2..3→5, 4..7→8, >=8→13.
 */
export function rrFromFanout(n: number): Fib {
  if (n <= 0) return 1;
  if (n === 1) return 3;
  if (n <= 3) return 5;
  if (n <= 7) return 8;
  return 13;
}

/**
 * Risk/Reduction-of-opportunity contribution from severity class.
 *
 * Canonical: none→1, tech_debt→3, security/data_loss/compliance→8.
 */
export function rrFromSeverity(s: SeverityClass): Fib {
  switch (s) {
    case 'none':
      return 1;
    case 'tech_debt':
      return 3;
    case 'security':
    case 'data_loss':
    case 'compliance':
      return 8;
  }
}

const TYPO_KEYWORDS = ['typo', 'config', 'copy'];
const HEAVY_KEYWORDS = ['refactor', 'migrate', 'rewrite', 'new subsystem'];

/**
 * Deterministic job-size BAND `[low, high]` constraining the LLM's chosen
 * `jobSizeTier`. When `filesTouched` is known it dominates; otherwise keyword
 * priors over the task text apply, with a wide [1,13] default.
 *
 * `filesTouched` known:
 *   1     → [1, 2]
 *   2..3  → [2, 5]
 *   4..8  → [5, 8]
 *   > 8   → [8, 13]
 *
 * else keyword priors (case-insensitive substring over `text`):
 *   typo / config / copy                          → [1, 3]
 *   refactor / migrate / rewrite / new subsystem  → [8, 13]
 *   default                                        → [1, 13]
 *
 * Accepts the deterministic `filesTouched` count (or null when not linkable)
 * directly — callers holding a full `WsjfFeatures` pass `f.filesTouched`.
 */
export function jobSizeBand(
  filesTouched: number | null,
  text: string,
): [Fib, Fib] {
  if (filesTouched !== null) {
    if (filesTouched <= 1) return [1, 2];
    if (filesTouched <= 3) return [2, 5];
    if (filesTouched <= 8) return [5, 8];
    return [8, 13];
  }
  const lower = (text ?? '').toLowerCase();
  if (TYPO_KEYWORDS.some((k) => lower.includes(k))) return [1, 3];
  if (HEAVY_KEYWORDS.some((k) => lower.includes(k))) return [8, 13];
  return [1, 13];
}

/** Move one Fibonacci tier down (saturating at 1). */
function oneStepDown(weight: Fib): Fib {
  const idx = FIB.indexOf(weight);
  if (idx <= 0) return 1;
  return FIB[idx - 1];
}

/**
 * User-Business-Value tier from a theme's Fibonacci weight and the task's
 * alignment to that theme.
 *
 * Canonical:
 *   core   → weight
 *   direct → oneStepDown(weight)
 *   weak   → twoStepsDown(weight)  (oneStepDown applied twice)
 *   none   → 1
 *
 * oneStepDown: 13→8, 8→5, 5→3, 3→2, 2→1, 1→1.
 */
export function ubvFromThemeAlignment(
  weight: Fib,
  a: AlignmentClass,
): Fib {
  switch (a) {
    case 'core':
      return weight;
    case 'direct':
      return oneStepDown(weight);
    case 'weak':
      return oneStepDown(oneStepDown(weight));
    case 'none':
      return 1;
  }
}

/**
 * The core WSJF formula:
 *   (value + timeCriticality + riskOpportunity) / max(jobSize, 1)
 *
 * `jobSize` of 0 is treated as 1 to avoid division by zero. Returns a raw
 * (non-clamped) number; callers round/format for display.
 *
 * Canonical: {value:13, timeCriticality:5, riskOpportunity:8, jobSize:5} → 5.2.
 */
export function computeWsjf(c: WsjfComponents): number {
  const denominator = Math.max(c.jobSize, 1);
  return (c.value + c.timeCriticality + c.riskOpportunity) / denominator;
}

/**
 * Fallback ordering score for tasks with no WSJF components — derived solely
 * from the task's priority so unscored tasks still sort sensibly.
 *
 * Canonical: urgent→9, high→6, medium→3, low→1.
 */
export function priorityFallbackScore(p: Priority): number {
  switch (p) {
    case 'urgent':
      return 9;
    case 'high':
      return 6;
    case 'medium':
      return 3;
    case 'low':
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Task #626 (WSJF 1.6) — `validateScoreSubmission`, the deterministic gate.
//
// Every write path (MCP + REST) funnels through this one pure function before
// persistence (design spec §12.3). It NEVER trusts a client-supplied number:
// on success it recomputes the four Fibonacci components from the submitted
// `classification` + `features` via the deterministic functions above, and on
// failure it returns a structured `errors[]` for a bounded agent retry.
//
// Shapes mirror the plan's §"Validation gate" Contracts block. `ValidateContext`
// is extended with `sourceText` because §12.2 requires each evidence span to be
// a *verbatim substring of the source* — the charter alone is not enough source
// material (most spans cite the task text), so the gate checks each span against
// the union of `sourceText` + charter-derived text.
// ---------------------------------------------------------------------------

/**
 * What an agent submits for a single task: the bounded enum classification plus
 * the deterministic features the server gathered. Mirrors `ScoreSubmissionSchema`
 * in `wsjf.schema.ts`; the runtime number is NEVER part of the submission.
 */
export interface ScoreSubmission {
  classification: WsjfClassification;
  features: WsjfFeatures;
}

/**
 * Deterministic context the gate validates against.
 *  - `charter`: the project's value charter, or null (charter-less project).
 *  - `sourceText`: the task text (and any other free-form source) the evidence
 *    spans must literally occur in. Optional — when omitted only charter text
 *    backs the spans.
 *  - `batch`: when scoring a whole candidate batch column-anchored, the full set
 *    of server-computed components (including this submission's). Enables the
 *    batch invariants (every CoD column has a `1` anchor; variance ≥ floor).
 */
export interface ValidateContext {
  charter: ValueCharter | null;
  sourceText?: string;
  batch?: WsjfComponents[];
}

/**
 * The gate's verdict. On `ok`, `components` carries the server-computed scores
 * (client numbers ignored). On failure, `errors[]` enumerates every violation
 * so a bounded retry can fix them in one pass.
 */
export interface ValidateResult {
  ok: boolean;
  components?: WsjfComponents;
  errors: string[];
}

/**
 * Minimum required spread across a column of a column-anchored batch. A batch
 * whose Cost-of-Delay columns are all identical (zero variance) collapses the
 * relative anchoring the whole method depends on, so it is rejected and
 * re-prompted (design spec §12.3 invariant 4). Population variance is used.
 */
export const VARIANCE_FLOOR = 0.5;

/** The three Cost-of-Delay (numerator) columns checked by the batch invariants. */
const COD_COLUMNS: readonly (keyof WsjfComponents)[] = [
  'value',
  'timeCriticality',
  'riskOpportunity',
];

/** Population variance of a numeric series (0 for empty / singleton). */
function populationVariance(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
}

/**
 * Build the deterministic UBV tier for a submission. When a charter is present
 * and the submission names a theme, use that theme's Fibonacci weight; otherwise
 * (charter-less / themeName=null) the weight defaults to 1 so UBV collapses to
 * the alignment floor — keeping the gate pure and avoiding NaN.
 */
function ubvFor(
  classification: WsjfClassification,
  charter: ValueCharter | null,
): Fib {
  let weight: Fib = 1;
  if (charter && classification.themeName !== null) {
    const theme = charter.value_themes.find(
      (t) => t.name === classification.themeName,
    );
    if (theme) weight = theme.weight;
  }
  return ubvFromThemeAlignment(weight, classification.alignment);
}

/**
 * Task #643 (WSJF 4.3): the SINGLE source of truth for cross-component
 * contradiction rules. Both the classified/auto gate
 * ({@link validateScoreSubmission} step 5) and the manual-override gate
 * ({@link validateManualScore}) call this — neither reimplements the rule, so
 * a contradiction is rejected identically no matter how the components arrived.
 *
 * Current rule (design spec §12.3): a trivial-effort task (`jobSize=1`) cannot
 * simultaneously carry maximum business value (`value=13`). Returns one error
 * string per violated rule (empty array when consistent).
 */
export function checkComponentContradictions(c: WsjfComponents): string[] {
  const errors: string[] = [];
  if (c.jobSize === 1 && c.value === 13) {
    errors.push(
      'contradiction: jobSize=1 (trivial effort) but value=13 (max business value)',
    );
  }
  return errors;
}

/**
 * Task #643 (WSJF 4.3): the MANUAL-override gate. A human (not the LLM) sets the
 * four Fibonacci components DIRECTLY, so this path is EXEMPT from the
 * classification / verbatim-evidence / theme / job-size-band checks the
 * {@link validateScoreSubmission} gate enforces — there is no classification to
 * validate. It is NOT exempt from:
 *   1. enum membership — each component must be a Fibonacci tier (via
 *      {@link WsjfComponentsSchema}); off-scale integers (4, 6, 7, ...) reject.
 *   2. the cross-component contradiction rules — reuses the shared
 *      {@link checkComponentContradictions} (NOT a fork), so jobSize=1 ∧ value=13
 *      is rejected on the manual path exactly as on the auto path.
 *
 * Pure; no I/O. On success returns the validated `components` echoed back.
 */
export function validateManualScore(input: unknown): ValidateResult {
  const errors: string[] = [];

  const parsed = WsjfComponentsSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      errors.push(path ? `${path}: ${issue.message}` : issue.message);
    }
    return { ok: false, errors };
  }

  const components = parsed.data as WsjfComponents;
  errors.push(...checkComponentContradictions(components));

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, components, errors: [] };
}

/**
 * The deterministic chokepoint. Pure in `(submission, ctx)`. Runs, in order:
 *  1. Zod enum membership / all-fields shape (via `ScoreSubmissionSchema`).
 *  2. themeName presence: must exist in the charter; `null` allowed ONLY when
 *     `charter === null`.
 *  3. Verbatim evidence spans: each of the four spans must be a substring of the
 *     source text (task text ∪ charter-derived text).
 *  4. `jobSizeTier` within `jobSizeBand(features, sourceText)`.
 *  5. Cross-component contradiction rules (e.g. jobSize=1 ∧ value=13 → error).
 *  6. Batch invariants when `ctx.batch` present: every CoD column has a `1`
 *     anchor AND each column's variance ≥ {@link VARIANCE_FLOOR}.
 *
 * On success returns server-computed `components` (any client number ignored).
 */
export function validateScoreSubmission(
  s: ScoreSubmission,
  ctx: ValidateContext,
): ValidateResult {
  const errors: string[] = [];

  // 1. Enum membership / shape — the schema rejects off-scale Fibonacci tiers,
  //    unknown enum members, empty evidence spans, and extra keys.
  const parsed = ScoreSubmissionSchema.safeParse(s);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      errors.push(path ? `${path}: ${issue.message}` : issue.message);
    }
    // Without a structurally valid submission the remaining checks would throw
    // on missing fields, so short-circuit here.
    return { ok: false, errors };
  }

  const { classification, features } = s;

  // 2. themeName presence in charter (null only when charter is null).
  if (ctx.charter === null) {
    if (classification.themeName !== null) {
      errors.push(
        `themeName "${classification.themeName}" supplied but project has no charter (only null allowed)`,
      );
    }
  } else if (classification.themeName === null) {
    errors.push('themeName=null is only allowed when the project has no charter');
  } else {
    const known = ctx.charter.value_themes.some(
      (t) => t.name === classification.themeName,
    );
    if (!known) {
      errors.push(
        `themeName "${classification.themeName}" is not a theme in the project charter`,
      );
    }
  }

  // 3. Verbatim evidence-span substring checks against the source material.
  const charterText = ctx.charter
    ? [
        ctx.charter.mission,
        ctx.charter.time_context,
        ctx.charter.risk_posture,
        ...ctx.charter.value_themes.flatMap((t) => [t.name, t.description]),
      ].join('\n')
    : '';
  const source = `${ctx.sourceText ?? ''}\n${charterText}`;
  for (const key of ['value', 'timeCriticality', 'riskOpportunity', 'jobSize'] as const) {
    const span = classification.evidence[key];
    if (!source.includes(span)) {
      errors.push(
        `evidence.${key} span is not a verbatim substring of the source text: "${span}"`,
      );
    }
  }

  // 4. jobSizeTier within the deterministic band.
  const [bandLow, bandHigh] = jobSizeBand(
    features.filesTouched,
    ctx.sourceText ?? '',
  );
  if (classification.jobSizeTier < bandLow || classification.jobSizeTier > bandHigh) {
    errors.push(
      `jobSizeTier ${classification.jobSizeTier} is outside the allowed band [${bandLow}, ${bandHigh}]`,
    );
  }

  // Server-computed components (recompute, never trust a client number).
  const value = ubvFor(classification, ctx.charter);
  const timeCriticality =
    features.daysUntilDeadline !== null
      ? tcFromDaysUntil(features.daysUntilDeadline)
      : tcFromDecayClass(classification.decay ?? 'flat');
  const riskOpportunity = Math.max(
    rrFromFanout(features.transitiveDependents),
    rrFromSeverity(classification.severity),
  ) as Fib;
  const jobSize = classification.jobSizeTier;
  const components: WsjfComponents = {
    value,
    timeCriticality,
    riskOpportunity,
    jobSize,
  };

  // 5. Cross-component contradiction rules (shared with the manual gate —
  //    task #643 — so both paths reject identically; see
  //    {@link checkComponentContradictions}).
  errors.push(...checkComponentContradictions(components));

  // 6. Batch invariants (column-anchored relative scoring).
  if (ctx.batch !== undefined) {
    for (const col of COD_COLUMNS) {
      const colVals = ctx.batch.map((c) => c[col]);
      if (!colVals.includes(1)) {
        errors.push(
          `batch invariant: CoD column "${col}" has no 1 anchor (relative anchoring requires a baseline)`,
        );
      }
      if (populationVariance(colVals) < VARIANCE_FLOOR) {
        errors.push(
          `batch invariant: CoD column "${col}" variance below floor ${VARIANCE_FLOOR} (degenerate, all-similar batch)`,
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, components, errors: [] };
}

// ---------------------------------------------------------------------------
// Task #644 (WSJF 4.4) — propagation of a parent's VALUE prior to derived tasks
// (subtasks + decompose children). Design spec §8.5:
//
//   "when a WSJF-scored task spawns subtasks or decompose-children, children
//    inherit the parent's value-theme mapping + a Business-Value prior (value
//    flows down the tree); per-child objective components (Job Size, fan-out)
//    are scored fresh. A manually-set parent value is propagated as a
//    human-anchored prior (flagged so it is visible)."
//
// ONLY the VALUE dimension flows down: the inherited `themeName` (value-theme
// mapping) and the parent's Business-Value (UBV) tier. The three OBJECTIVE
// components — Time Criticality, Risk/Opportunity, Job Size — are deliberately
// NOT inherited; each derived task scores them fresh from its own deadline,
// DAG fan-out, and scope. When the parent's VALUE component was human-set
// (`wsjf_source.value === 'manual'`), the prior is flagged human-anchored so a
// downstream rescore can treat it as a pinned input rather than a free guess.
// ---------------------------------------------------------------------------

/**
 * The minimal parent state {@link derivePropagatedValuePrior} reads: the
 * parent's persisted Business-Value tier, the theme it was mapped to (the
 * `wsjf_classifications.themeName`, may be null on a charter-less project), and
 * its per-component provenance map (to detect a human-set value).
 */
export interface PropagationParent {
  wsjf_value: Fib | null;
  wsjf_classifications: WsjfClassification | null;
  wsjf_source: WsjfSource | null;
}

/**
 * The VALUE-only prior a derived task inherits from its parent. `value` is the
 * inherited Business-Value tier; `themeName` is the inherited value-theme
 * mapping (null on a charter-less parent); `humanAnchored` is true when the
 * parent's VALUE component was human-set (`wsjf_source.value === 'manual'`),
 * so the prior is a pinned human anchor rather than an agent guess. The three
 * objective components are intentionally absent — the caller scores them fresh.
 */
export interface PropagatedValuePrior {
  value: Fib;
  themeName: string | null;
  humanAnchored: boolean;
}

/**
 * Task #644 (WSJF 4.4): derive the VALUE prior a derived task (subtask or
 * decompose child) inherits from its scored parent. Pure; no I/O.
 *
 * Returns `null` when the parent is unscored (no `wsjf_value`) — there is no
 * value to flow down, so the child is scored entirely fresh. Otherwise the
 * child inherits the parent's `value` tier + `themeName` mapping, and the
 * `humanAnchored` flag mirrors whether the parent's value was manual. The
 * returned object NEVER carries time-criticality / risk / job-size: those are
 * objective and MUST be scored fresh per child (design spec §8.5).
 */
export function derivePropagatedValuePrior(
  parent: PropagationParent,
): PropagatedValuePrior | null {
  if (parent.wsjf_value === null) return null;
  return {
    value: parent.wsjf_value,
    themeName: parent.wsjf_classifications?.themeName ?? null,
    humanAnchored: parent.wsjf_source?.value === 'manual',
  };
}

// ---------------------------------------------------------------------------
// Task #629 (WSJF 1.9) — `rankFrontier` + downstream Cost-of-Delay propagation.
//
// This is the read-time ranking pipeline. It is the ONLY place the derived
// `effective_wsjf` is produced (see `TaskWithWsjfScore` in `types/task.ts`):
// nothing is persisted. The propagation model is the design spec §6 formula:
//
//   base_CoD(n)      = value + timeCriticality + riskOpportunity
//   effective_CoD(n) = base_CoD(n)
//                      + Σ_{d ∈ distinctTransitiveDependents(n)}
//                            base_CoD(d) · γ^(dist(n,d) − 1)
//                      capped at base_CoD(n) · CAP
//   effective_wsjf   = effective_CoD / max(jobSize, 1)
//
// with γ = PROPAGATION_GAMMA (0.5) and CAP = PROPAGATION_CAP (3). The sum is
// taken over the *distinct transitive closure* of dependents — a diamond
// (A→{B,C}→D) counts the shared descendant D exactly once per ancestor, using
// the SHORTEST hop distance for the γ exponent (BFS), so path-count explosions
// can never inflate a blocker. Cycles are impossible here because we route the
// graph through `TopologyService.classify`, which rejects `DAG_CYCLIC` up front
// (we raise the same `BusinessError` the rest of the service layer uses).
//
// Edge orientation (from `TopologyService` / `task_dependencies`): an edge is
// `{from, to}` meaning `from` must finish before `to` can start — so `to` is a
// DOWNSTREAM dependent of `from`. Propagation flows dependents' CoD UP onto
// their blockers, i.e. along reversed edges from `n` to everything reachable
// by following `from → to`.
//
// Scope:
//   - 'all'      → rank every task in the project.
//   - 'frontier' → exclude tasks that are not ready: status === 'blocked', OR
//                  any same-project blocker (an incoming `from → to` edge whose
//                  `from` end is this task) is not in {done, closed}. Mirrors
//                  the `/tasks:loop-dag` frontier definition (orphaned / cross-
//                  project blocker edges are dropped by TopologyService already,
//                  so they never gate a task).
// ---------------------------------------------------------------------------

/**
 * One task's WSJF standing after read-time ranking. `effectiveWsjf` is the
 * sort key (descending). For scored tasks it is the propagation-adjusted ratio;
 * for unscored tasks it is the {@link priorityFallbackScore}. `propagation`
 * enumerates each distinct downstream dependent's γ-decayed contribution to
 * this task's effective Cost-of-Delay (empty for unscored tasks or leaves).
 */
export interface RankedTask {
  taskId: number;
  scored: boolean;
  baseWsjf: number | null;
  effectiveWsjf: number;
  components: WsjfComponents | null;
  propagation: { dependentId: number; contribution: number }[];
  evidence: WsjfEvidence | null;
}

/**
 * Collaborators `rankFrontier` needs to gather the DAG closure and task rows.
 * Injected (rather than constructed) so the function stays unit-testable
 * against real in-memory repositories — the same pattern the topology tests
 * use. `topology` supplies the project-scoped, orphan-filtered, cycle-guarded
 * edge set; `tasks` supplies the rows; `dependency` is the underlying edge
 * authority that `topology` is built over (kept in the contract per spec §6).
 */
export interface RankDeps {
  topology: TopologyService;
  dependency: DependencyService;
  tasks: ITaskRepository;
}

type ScoredTask = Task & { tags?: string[] };

const RANKED_DONE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'done',
  'closed',
]);

/** All four WSJF components present (a fully-scored task)? */
function hasComponents(t: Task): t is Task & {
  wsjf_value: Fib;
  wsjf_time_criticality: Fib;
  wsjf_risk_opportunity: Fib;
  wsjf_job_size: Fib;
} {
  return (
    t.wsjf_value !== null &&
    t.wsjf_time_criticality !== null &&
    t.wsjf_risk_opportunity !== null &&
    t.wsjf_job_size !== null
  );
}

/** Page through every task in the project (findByFilters clamps at 500). */
function loadProjectTasks(
  tasks: ITaskRepository,
  projectId: number,
): ScoredTask[] {
  const expected = tasks.count({ project_id: projectId });
  const out: ScoredTask[] = [];
  let offset = 0;
  while (out.length < expected) {
    const page = tasks.findByFilters({
      project_id: projectId,
      limit: MAX_PAGE_LIMIT,
      offset,
      include_tags: false,
    });
    if (page.length === 0) break;
    out.push(...page);
    offset += page.length;
  }
  return out;
}

/**
 * Rank a project's tasks by propagation-adjusted WSJF.
 *
 * @param projectId  project to rank.
 * @param scope      `'all'` ranks every task; `'frontier'` excludes blocked /
 *                   not-ready tasks (see module header).
 * @param deps       injected topology / dependency / task collaborators.
 * @returns          `RankedTask[]` sorted descending by `effectiveWsjf`, with a
 *                   stable tie-break of `created_at` then `id` (ascending).
 * @throws BusinessError when the project's dependency graph is `DAG_CYCLIC`.
 */
export async function rankFrontier(
  projectId: number,
  scope: 'frontier' | 'all',
  deps: RankDeps,
): Promise<RankedTask[]> {
  // 1. Cycle guard — route through the topology classifier. A cyclic graph has
  //    no orderable frontier and the propagation closure would never terminate,
  //    so reject before doing any work.
  const report = deps.topology.classify(projectId);
  if (report.topology === 'DAG_CYCLIC') {
    throw new BusinessError(
      `Cannot rank project ${projectId}: dependency graph is cyclic (DAG_CYCLIC); break the cycle before ranking`,
    );
  }

  const allTasks = loadProjectTasks(deps.tasks, projectId);
  const taskById = new Map<number, ScoredTask>();
  for (const t of allTasks) taskById.set(t.id, t);

  // 2. Build the downstream adjacency (blocker → dependents) from the project-
  //    scoped, orphan-filtered edge set the topology classifier produced.
  //    Edge {from, to}: `from` blocks `to`, so `to` is a downstream dependent.
  const downstream = new Map<number, number[]>();
  const blockersOf = new Map<number, number[]>();
  for (const id of taskById.keys()) {
    downstream.set(id, []);
    blockersOf.set(id, []);
  }
  for (const e of report.edges) {
    downstream.get(e.from)!.push(e.to);
    blockersOf.get(e.to)!.push(e.from);
  }

  // 3. base_CoD per scored task = value + timeCriticality + riskOpportunity.
  const baseCoD = new Map<number, number>();
  for (const t of allTasks) {
    if (hasComponents(t)) {
      baseCoD.set(
        t.id,
        t.wsjf_value + t.wsjf_time_criticality + t.wsjf_risk_opportunity,
      );
    }
  }

  // 4. distinctTransitiveDependents(n) via BFS over `downstream`, recording the
  //    SHORTEST hop distance to each dependent (diamond-safe dedupe: each
  //    descendant appears once, at its minimum distance). Then fold each
  //    dependent's base_CoD · γ^(dist−1) onto n, capped at base_CoD(n)·CAP.
  const propagationOf = new Map<
    number,
    { dependentId: number; contribution: number }[]
  >();
  const effectiveCoD = new Map<number, number>();

  for (const t of allTasks) {
    if (!hasComponents(t)) continue;
    const base = baseCoD.get(t.id)!;

    // BFS shortest-distance closure of downstream dependents.
    const distance = new Map<number, number>();
    const queue: number[] = [t.id];
    distance.set(t.id, 0);
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = distance.get(cur)!;
      for (const next of downstream.get(cur) ?? []) {
        if (!distance.has(next)) {
          distance.set(next, d + 1);
          queue.push(next);
        }
      }
    }

    const contributions: { dependentId: number; contribution: number }[] = [];
    let sum = 0;
    // Deterministic order: ascending dependent id.
    const dependentIds = [...distance.keys()]
      .filter((id) => id !== t.id)
      .sort((a, b) => a - b);
    for (const depId of dependentIds) {
      const depBase = baseCoD.get(depId);
      if (depBase === undefined) continue; // unscored dependents contribute nothing
      const dist = distance.get(depId)!;
      const contribution = depBase * Math.pow(PROPAGATION_GAMMA, dist - 1);
      if (contribution === 0) continue;
      contributions.push({ dependentId: depId, contribution });
      sum += contribution;
    }

    const uncapped = base + sum;
    const capped = Math.min(uncapped, base * PROPAGATION_CAP);
    effectiveCoD.set(t.id, capped);
    propagationOf.set(t.id, contributions);
  }

  // 5. Frontier filtering — drop not-ready tasks when scope === 'frontier'.
  const isReady = (t: ScoredTask): boolean => {
    if (t.status === 'blocked') return false;
    for (const blockerId of blockersOf.get(t.id) ?? []) {
      const blocker = taskById.get(blockerId);
      // Orphaned / cross-project blockers are already absent from `report.edges`
      // (TopologyService drops them), so any blocker we see here is in-project.
      if (blocker && !RANKED_DONE_STATUSES.has(blocker.status)) return false;
    }
    return true;
  };

  const scopedTasks =
    scope === 'frontier' ? allTasks.filter(isReady) : allTasks;

  // 6. Materialize RankedTask rows.
  const ranked: RankedTask[] = scopedTasks.map((t) => {
    if (hasComponents(t)) {
      const components: WsjfComponents = {
        value: t.wsjf_value,
        timeCriticality: t.wsjf_time_criticality,
        riskOpportunity: t.wsjf_risk_opportunity,
        jobSize: t.wsjf_job_size,
      };
      const baseWsjf = computeWsjf(components);
      const effCoD = effectiveCoD.get(t.id) ?? baseCoD.get(t.id)!;
      const effectiveWsjf = effCoD / Math.max(components.jobSize, 1);
      return {
        taskId: t.id,
        scored: true,
        baseWsjf,
        effectiveWsjf,
        components,
        propagation: propagationOf.get(t.id) ?? [],
        evidence: t.wsjf_evidence ?? null,
      };
    }
    // Unscored → priority fallback. effectiveWsjf is the fallback score so the
    // sort key is uniform; scored tasks (real ratios) and fallback tasks live
    // in the same ordering space (spec §6 step 4 + the priority→WSJF map).
    return {
      taskId: t.id,
      scored: false,
      baseWsjf: null,
      effectiveWsjf: priorityFallbackScore(t.priority as Priority),
      components: null,
      propagation: [],
      evidence: null,
    };
  });

  // 7. Sort: effectiveWsjf DESC, then created_at ASC, then id ASC (deterministic).
  ranked.sort((a, b) => {
    if (b.effectiveWsjf !== a.effectiveWsjf) {
      return b.effectiveWsjf - a.effectiveWsjf;
    }
    const ta = taskById.get(a.taskId)!;
    const tb = taskById.get(b.taskId)!;
    if (ta.created_at !== tb.created_at) {
      return ta.created_at < tb.created_at ? -1 : 1;
    }
    return a.taskId - b.taskId;
  });

  return ranked;
}

// ---------------------------------------------------------------------------
// Task #635 (WSJF 2.4) — tiered, selective redundancy with median aggregation
// and verifier escalation (design spec §12.4).
//
// This is the read-time reliability layer that sits ON TOP of the deterministic
// gate. It does NOT run for every task: redundancy is *selective*, applied only
// to HIGH-STAKES classifications where extra sampling actually changes outcomes
// — tasks near the top of the ready frontier, OR tasks the deterministic layer
// could not decide (a contradiction rule fired / job-size is maximally
// ambiguous). Everything else gets a single deterministic-first pass.
//
// Tier 1 — N-sample self-consistency: classify N times (default 3), take the
// per-component MEDIAN Fibonacci bucket (deterministic aggregation: median over
// the ORDINAL position in `FIB`, lower-median on an even sample count so the
// result is reproducible and never invents a tier that wasn't sampled).
//
// Tier 2 — independent verifier: triggered ONLY when the Tier-1 samples
// disagree beyond tolerance (max ordinal spread on any component) OR a
// contradiction rule fires on the aggregate. A fresh-context verifier
// re-classifies blind; if it agrees within tolerance the aggregate stands,
// otherwise the disagreeing components are marked LOW-CONFIDENCE and flagged for
// human review (persistent disagreement → low-confidence flag).
//
// All aggregation here is PURE (no I/O, no clock, no randomness). The sampling
// and verifier calls are injected as async callbacks so the orchestration is
// unit-testable with mocks — the scoring skill supplies the real LLM-backed
// sampler + `tasks-verifier` sub-agent.
// ---------------------------------------------------------------------------

/** The four WSJF component keys, in canonical order. */
const COMPONENT_KEYS: readonly WsjfComponentKey[] = [
  'value',
  'timeCriticality',
  'riskOpportunity',
  'jobSize',
];

/** Default number of Tier-1 self-consistency samples (design spec §12.4). */
export const DEFAULT_REDUNDANCY_SAMPLES = 3;

/**
 * Per-component disagreement tolerance, expressed as a maximum allowed spread in
 * ORDINAL Fibonacci steps. `0` = every sample must land on the identical tier;
 * `1` (default) = samples may straddle one adjacent tier (e.g. 5↔8) before the
 * component is considered to disagree and Tier-2 escalation fires.
 */
export const DEFAULT_REDUNDANCY_TOLERANCE = 1;

/** Ordinal index of a Fibonacci tier within {@link FIB} (0..5). */
function fibOrdinal(f: Fib): number {
  return FIB.indexOf(f);
}

/**
 * Deterministic MEDIAN Fibonacci bucket of a non-empty sample of tiers. Median
 * is taken over the ORDINAL position in {@link FIB} (so 3 and 8 median to 5, not
 * an arithmetic mean), and uses the LOWER median on an even count so the result
 * is fully reproducible and is always one of the sampled-tier neighbourhood.
 *
 * Canonical: [5] → 5; [3,5,8] → 5; [8,8,3] → 8; [2,5] → 2 (lower median).
 *
 * @throws Error on an empty sample (a median of nothing is undefined).
 */
export function fibMedianBucket(samples: Fib[]): Fib {
  if (samples.length === 0) {
    throw new Error('fibMedianBucket: cannot take the median of an empty sample');
  }
  const ordinals = samples.map(fibOrdinal).sort((a, b) => a - b);
  // Lower median: for odd N the true middle; for even N the lower of the two.
  const mid = Math.floor((ordinals.length - 1) / 2);
  return FIB[ordinals[mid]];
}

/**
 * Aggregate N component samples into a single {@link WsjfComponents} by taking
 * the {@link fibMedianBucket} of each component independently. Deterministic for
 * a fixed sample set regardless of input order.
 *
 * @throws Error when given no samples.
 */
export function aggregateSamples(samples: WsjfComponents[]): WsjfComponents {
  if (samples.length === 0) {
    throw new Error('aggregateSamples: at least one component sample is required');
  }
  const out = {} as WsjfComponents;
  for (const key of COMPONENT_KEYS) {
    out[key] = fibMedianBucket(samples.map((s) => s[key]));
  }
  return out;
}

/**
 * The ordinal SPREAD of a single component across a sample set: the difference
 * between the highest and lowest Fibonacci ordinal observed. `0` means perfect
 * agreement. Pure.
 */
export function componentSpread(samples: WsjfComponents[], key: WsjfComponentKey): number {
  if (samples.length === 0) return 0;
  const ords = samples.map((s) => fibOrdinal(s[key]));
  return Math.max(...ords) - Math.min(...ords);
}

/**
 * Which components disagree beyond `tolerance` across the Tier-1 samples — i.e.
 * their ordinal spread exceeds the allowed step count. Returns the keys in
 * canonical order (empty = the whole sample set agrees within tolerance). Pure.
 */
export function disagreeingComponents(
  samples: WsjfComponents[],
  tolerance: number = DEFAULT_REDUNDANCY_TOLERANCE,
): WsjfComponentKey[] {
  return COMPONENT_KEYS.filter((key) => componentSpread(samples, key) > tolerance);
}

/**
 * Does a task warrant the redundant (multi-sample + maybe-verifier) path?
 * Redundancy is SELECTIVE — applied only where it changes outcomes:
 *   - `topOfFrontier`: the task sits at/near the top of the ready frontier (the
 *     caller decides the cut, e.g. rank index < K), where a wrong bucket would
 *     reorder what runs next; OR
 *   - `deterministicUndecided`: the deterministic layer could not decide — a
 *     contradiction rule fired, or the job-size band is maximally wide ([1,13]),
 *     so a single sample is least trustworthy.
 *
 * Ordinary tasks (neither flag) take the single deterministic-first pass and are
 * NOT scored redundantly. Pure.
 */
export function isHighStakes(input: {
  topOfFrontier: boolean;
  deterministicUndecided: boolean;
}): boolean {
  return input.topOfFrontier || input.deterministicUndecided;
}

/**
 * Outcome of the redundant scoring orchestration for one task.
 *  - `components`: the aggregated (Tier-1 median, possibly verifier-confirmed)
 *    components.
 *  - `escalated`: whether Tier-2 (the independent verifier) was invoked.
 *  - `lowConfidence`: components that remained in disagreement AFTER the verifier
 *    (persistent disagreement) — flagged for human review. Empty on agreement.
 *  - `samples`: the raw Tier-1 samples (for audit / telemetry).
 */
export interface RedundantScoreResult {
  components: WsjfComponents;
  escalated: boolean;
  lowConfidence: WsjfComponentKey[];
  samples: WsjfComponents[];
}

/**
 * Tiered redundancy orchestrator (design spec §12.4). PURE in its inputs except
 * for the two injected async callbacks, which the scoring skill wires to the
 * real LLM sampler and the `tasks-verifier` sub-agent.
 *
 * Flow:
 *  1. Tier 1 — call `sample()` N times; take the per-component median bucket
 *     ({@link aggregateSamples}).
 *  2. Decide escalation: the samples disagree beyond `tolerance` on some
 *     component, OR a contradiction rule fires on the aggregate
 *     ({@link checkComponentContradictions}).
 *  3. Tier 2 — if escalating and a `verify` callback is supplied, call it once
 *     for a blind re-classification. For each disagreeing component: if the
 *     verifier lands within `tolerance` of the aggregate bucket, the aggregate
 *     stands; otherwise that component is marked LOW-CONFIDENCE (persistent
 *     disagreement) and flagged.
 *
 * @param opts.samples    Tier-1 sample count (default {@link DEFAULT_REDUNDANCY_SAMPLES}).
 * @param opts.tolerance  ordinal-step tolerance (default {@link DEFAULT_REDUNDANCY_TOLERANCE}).
 * @param sample          async producer of one component sample.
 * @param verify          async independent verifier; omit to skip Tier 2 (in
 *                        which case a beyond-tolerance disagreement marks the
 *                        component low-confidence directly).
 */
export async function redundantScore(
  sample: () => Promise<WsjfComponents>,
  verify: (() => Promise<WsjfComponents>) | undefined,
  opts: { samples?: number; tolerance?: number } = {},
): Promise<RedundantScoreResult> {
  const n = Math.max(1, opts.samples ?? DEFAULT_REDUNDANCY_SAMPLES);
  const tolerance = opts.tolerance ?? DEFAULT_REDUNDANCY_TOLERANCE;

  const samples: WsjfComponents[] = [];
  for (let i = 0; i < n; i++) {
    samples.push(await sample());
  }
  const aggregate = aggregateSamples(samples);

  const disagree = disagreeingComponents(samples, tolerance);
  const contradiction = checkComponentContradictions(aggregate).length > 0;
  const shouldEscalate = disagree.length > 0 || contradiction;

  // No escalation needed — Tier-1 median stands, full confidence.
  if (!shouldEscalate) {
    return { components: aggregate, escalated: false, lowConfidence: [], samples };
  }

  // Escalation warranted but no verifier wired: the disagreeing components are
  // unresolved → low-confidence directly (persistent disagreement).
  if (verify === undefined) {
    return {
      components: aggregate,
      escalated: false,
      lowConfidence: [...disagree],
      samples,
    };
  }

  // Tier 2 — blind independent re-classification.
  const verifierComponents = await verify();
  // The verifier weighs in on every component we were unsure about (the
  // disagreeing set, plus all components when a contradiction fired since the
  // aggregate itself is internally inconsistent).
  const underReview: WsjfComponentKey[] = contradiction
    ? [...COMPONENT_KEYS]
    : [...disagree];

  const lowConfidence: WsjfComponentKey[] = [];
  for (const key of underReview) {
    const spread = Math.abs(fibOrdinal(verifierComponents[key]) - fibOrdinal(aggregate[key]));
    if (spread > tolerance) {
      // Verifier still disagrees → persistent disagreement → low-confidence.
      lowConfidence.push(key);
    }
  }
  // Preserve canonical key order.
  lowConfidence.sort((a, b) => COMPONENT_KEYS.indexOf(a) - COMPONENT_KEYS.indexOf(b));

  return { components: aggregate, escalated: true, lowConfidence, samples };
}
