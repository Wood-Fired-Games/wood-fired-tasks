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
} from '../types/wsjf.js';
import { FIB } from '../types/wsjf.js';

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
