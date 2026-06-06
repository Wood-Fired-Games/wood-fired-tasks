// WSJF (Weighted Shortest Job First) prioritization — core enums & types.
//
// Task #621 (WSJF 1.1): the shared Contracts backbone every WSJF task depends
// on. This module is type-only plus the single `FIB` runtime constant; it holds
// NO logic. Names match the plan's §Contracts section verbatim — see
// `docs/superpowers/plans/2026-06-01-wsjf-prioritization.md` and the design spec
// `docs/superpowers/specs/2026-06-01-wsjf-prioritization-design.md`.

/** The closed Fibonacci tier set used for every WSJF component score. */
export type Fib = 1 | 2 | 3 | 5 | 8 | 13;

/**
 * Canonical ordered Fibonacci tiers. Typed as a fixed-shape readonly tuple so
 * that compile-time-constant indices are typed present (no `| undefined` under
 * `noUncheckedIndexedAccess`). Computed indices still require an in-range guard.
 */
export const FIB = [1, 2, 3, 5, 8, 13] as const satisfies readonly Fib[];

/** How well a task aligns with a charter value theme. */
export type AlignmentClass = 'none' | 'weak' | 'direct' | 'core';

/** Risk/severity bucket the task addresses. */
export type SeverityClass = 'none' | 'tech_debt' | 'security' | 'data_loss' | 'compliance';

/** How quickly the cost of delay grows when there is no hard deadline. */
export type DecayClass = 'flat' | 'slow' | 'fast';

/**
 * `trigger` values for a `wsjf_score_history` row.
 *
 * Spec §4.3 / plan §Contracts closed enum is
 * `{create, decompose, single_create, rescore, manual, propagation}`; task #628
 * adds `update` for the generic `update_task`-driven re-score path. The
 * migration's `trigger` column is `TEXT NOT NULL` with no CHECK, so every value
 * here persists; this union is the TS-level contract. Defined in this leaf
 * `types` module so schemas, repositories, and tools share it without an
 * upstream-layer import (dependency-cruiser `leaves-no-upstream`).
 */
export const WSJF_HISTORY_TRIGGERS = [
  'create',
  'update',
  'decompose',
  'single_create',
  'rescore',
  'manual',
  'propagation',
] as const;

export type WsjfHistoryTrigger = (typeof WSJF_HISTORY_TRIGGERS)[number];

/**
 * What the LLM emits — never a final number.
 */
export interface WsjfClassification {
  themeName: string | null; // must exist in charter.value_themes (or null = no charter)
  alignment: AlignmentClass;
  severity: SeverityClass;
  decay: DecayClass | null; // null when a deadline date is present
  jobSizeTier: Fib; // must fall inside jobSizeBand(features)
  evidence: WsjfEvidence; // verbatim spans, one per component
}

/** Verbatim source spans, one per WSJF component, backing a classification. */
export interface WsjfEvidence {
  value: string;
  timeCriticality: string;
  riskOpportunity: string;
  jobSize: string;
}

/**
 * Deterministic inputs the server gathers (no LLM).
 */
export interface WsjfFeatures {
  deadlineDate: string | null; // ISO; parsed from task text or charter.time_context
  daysUntilDeadline: number | null;
  transitiveDependents: number; // from the DAG
  filesTouched: number | null; // when linkable; else null
  charterVersion: number | null;
}

/** Stored, server-computed component scores. */
export interface WsjfComponents {
  value: Fib;
  timeCriticality: Fib;
  riskOpportunity: Fib;
  jobSize: Fib;
}

/** The four component keys of {@link WsjfComponents}. */
export type WsjfComponentKey = keyof WsjfComponents;

/** Per-component provenance: server-derived (`auto`) vs human-set (`manual`). */
export type WsjfSource = Record<WsjfComponentKey, 'auto' | 'manual'>;

/** Per-component lock flags — locked components survive a rescore. */
export type WsjfLocks = Record<WsjfComponentKey, boolean>;
