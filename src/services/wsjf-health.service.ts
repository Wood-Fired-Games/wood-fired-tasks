// WSJF (Weighted Shortest Job First) — degeneracy / pitfall linter.
//
// Task #646 (WSJF 5.1): the `wsjf_health` linter (design spec §9 + §11.4
// score-churn). It is NON-BLOCKING and SEVERITY-TAGGED. Surfaced in
// `project-status`, at the start of loop runs, and post-rescore. Every finding
// carries a plain-language explanation + a suggested fix, written for developers
// new to WSJF — a degenerate backlog should read like advice, not a stack trace.
//
// Design split (testability): the linter is a PURE function,
// {@link analyzeWsjfHealth}, over plain inputs — a list of {@link HealthTaskSnapshot}
// (the four components + deadline + priority/score state per task) and a
// per-task history-row map (for the score-churn check). It performs no I/O, no
// clock reads (the caller passes `now`), no randomness. The DB-backed
// {@link WsjfHealthService.check} is the thin gatherer that loads a project's
// tasks through the injected task repository and the append-only
// `wsjf_score_history` reader, then delegates to the pure analyzer. This mirrors
// the `rankFrontier` / `RankDeps` pattern: inject collaborators, keep the core
// pure.
//
// Checks implemented (spec §9 table + §11.4):
//   1. degenerate-spread     — scored tasks' WSJF scores are near-identical, so
//                              WSJF can't sequence them.
//   2. cod-no-anchor         — a Cost-of-Delay column (value / timeCriticality /
//                              riskOpportunity) has no `1` anchor across the
//                              scored set (violates SAFe relative-anchoring).
//   3. job-size-collapsed    — Job Size has collapsed to the 1–2 tiers (small-job
//                              bias; large work will starve).
//   4. stale-time-criticality— a task is past its deadline yet still carries a
//                              high Time Criticality (stale TC; rescore).
//   5. high-fallback-ratio   — too many ready tasks fall back to priority
//                              ordering instead of a real WSJF score (no
//                              reference frame; set a goal/charter).
//   6. score-churn           — a task's WSJF score flaps across consecutive
//                              rescore runs (unstable estimate) — detectable only
//                              because `wsjf_score_history` exists.

import type { ITaskRepository } from '../repositories/interfaces.js';
import type { IWsjfHistoryRepository } from '../repositories/wsjf-history.repository.js';
import type { Task, TaskPriority, TaskStatus } from '../types/task.js';
import type { WsjfComponents, WsjfComponentKey } from '../types/wsjf.js';
import { computeWsjf } from './wsjf.service.js';
import { MAX_PAGE_LIMIT } from '../types/task.js';

/** Severity tag on a health finding. Ordered low→high for sorting/surfacing. */
export type HealthSeverity = 'info' | 'warning' | 'critical';

/** The stable id of each check, so callers can filter / dedupe findings. */
export type HealthCheckId =
  | 'degenerate-spread'
  | 'cod-no-anchor'
  | 'job-size-collapsed'
  | 'stale-time-criticality'
  | 'high-fallback-ratio'
  | 'score-churn'
  | 'auto-sized-pending';

/** One linter finding: which check fired, how bad, why, and what to do. */
export interface HealthFinding {
  check: HealthCheckId;
  severity: HealthSeverity;
  /** Plain-language explanation of the pitfall (audience: WSJF newcomers). */
  message: string;
  /** Concrete suggested fix. */
  suggestion: string;
  /** Task ids this finding implicates (empty for project-wide findings). */
  taskIds: number[];
}

/** The linter's verdict for a project. `healthy` ⇔ `findings` is empty. */
export interface WsjfHealthReport {
  projectId: number;
  healthy: boolean;
  findings: HealthFinding[];
  /** How many scored tasks the analyzer considered (context for the caller). */
  scoredTaskCount: number;
}

/**
 * The per-task snapshot the pure analyzer consumes. Decoupled from the stored
 * {@link Task} so the checks are unit-testable over hand-crafted fixtures.
 *
 *  - `components` is the four server-computed Fibonacci tiers, or null for an
 *    unscored task.
 *  - `daysUntilDeadline` is (deadline − now) in whole days, or null when the
 *    task has no deadline. Negative ⇒ past-deadline. The caller computes this
 *    against an injected `now` so the analyzer stays clock-free.
 *  - `ready` marks a task eligible for the ready frontier (open + not blocked) —
 *    the fallback-ratio check only counts ready tasks.
 *  - `autoSized` is true when the task has a server-derived job size
 *    (`wsjf_source.jobSize === 'auto'`) but the Cost-of-Delay components have not
 *    been classified yet (value / timeCriticality / riskOpportunity are NULL).
 *    The `auto-sized-pending` check surfaces these tasks as info-level reminders.
 */
export interface HealthTaskSnapshot {
  taskId: number;
  components: WsjfComponents | null;
  priority: TaskPriority;
  daysUntilDeadline: number | null;
  ready: boolean;
  /** True when this task is auto-sized (jobSize only) awaiting full classification. */
  autoSized?: boolean;
}

/** One historical WSJF score for a task, oldest-first, for the churn check. */
export interface HealthHistoryPoint {
  /** The recorded WSJF score at this point, or null if never computed. */
  wsjfScore: number | null;
  /** Whether this point came from a rescore run (vs an initial create/update). */
  isRescore: boolean;
}

/** Tunable thresholds for the linter. Documented config-as-code (spec §11.3). */
export interface WsjfHealthThresholds {
  /**
   * Degenerate-spread: if (max − min) of the scored set's WSJF scores is at or
   * below this, the scores don't discriminate enough to sequence the backlog.
   * Only meaningful with ≥ {@link minTasksForSpread} scored tasks.
   */
  spreadFloor: number;
  /** Minimum scored tasks before the spread check is meaningful. */
  minTasksForSpread: number;
  /**
   * High-fallback-ratio: if the fraction of READY tasks that are unscored
   * (priority-fallback ordered) is at or above this, the backlog has no WSJF
   * reference frame. Only evaluated with ≥ {@link minReadyForFallback} ready
   * tasks.
   */
  fallbackRatioCeiling: number;
  /** Minimum ready tasks before the fallback-ratio check is meaningful. */
  minReadyForFallback: number;
  /**
   * Stale-time-criticality: a task this many days (or more) past its deadline
   * whose Time Criticality is at or above {@link staleTcTier} is flagged.
   */
  pastDeadlineDays: number;
  /** Time-Criticality tier at/above which a past-deadline task is "stale". */
  staleTcTier: number;
  /**
   * Score-churn: the number of DIRECTION REVERSALS across a task's rescore-run
   * score series at or above which the estimate is "flapping".
   */
  churnReversals: number;
}

/** Default thresholds (spec §9 / §11.4 intent; conservative, non-spammy). */
export const DEFAULT_HEALTH_THRESHOLDS: WsjfHealthThresholds = {
  spreadFloor: 0.5,
  minTasksForSpread: 3,
  fallbackRatioCeiling: 0.5,
  minReadyForFallback: 3,
  pastDeadlineDays: 0,
  staleTcTier: 8,
  churnReversals: 2,
};

/** The three Cost-of-Delay component columns (Job Size is the denominator). */
const COD_KEYS: readonly WsjfComponentKey[] = ['value', 'timeCriticality', 'riskOpportunity'];

/** Human-readable column labels for messages. */
const COL_LABEL: Record<WsjfComponentKey, string> = {
  value: 'User-Business Value',
  timeCriticality: 'Time Criticality',
  riskOpportunity: 'Risk/Opportunity',
  jobSize: 'Job Size',
};

/**
 * Pure degeneracy / pitfall linter (spec §9 + §11.4). Given per-task snapshots
 * and a per-task history-point series, return every finding. No I/O, no clock,
 * no randomness — `now` is folded into `daysUntilDeadline` by the caller.
 *
 * A backlog with no degeneracies returns an empty `findings` list (`healthy:
 * true`). Each check is independent and silent on a healthy backlog.
 */
export function analyzeWsjfHealth(
  projectId: number,
  snapshots: HealthTaskSnapshot[],
  historyByTask: Map<number, HealthHistoryPoint[]>,
  thresholds: WsjfHealthThresholds = DEFAULT_HEALTH_THRESHOLDS,
): WsjfHealthReport {
  const findings: HealthFinding[] = [];
  const scored = snapshots.filter(
    (s): s is HealthTaskSnapshot & { components: WsjfComponents } => s.components !== null,
  );

  // --- Check 1: degenerate spread ------------------------------------------
  if (scored.length >= thresholds.minTasksForSpread) {
    const scores = scored.map((s) => computeWsjf(s.components));
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread <= thresholds.spreadFloor) {
      findings.push({
        check: 'degenerate-spread',
        severity: 'warning',
        message:
          `All ${scored.length} scored tasks have near-identical WSJF scores ` +
          `(spread ${spread.toFixed(2)} ≤ ${thresholds.spreadFloor}). WSJF can't ` +
          `sequence a backlog whose scores don't differ — everything ties.`,
        suggestion:
          'Re-score the candidate set *relatively* against each other so the ' +
          'most valuable / smallest jobs rise above the rest, rather than ' +
          'scoring each task in isolation.',
        taskIds: scored.map((s) => s.taskId),
      });
    }
  }

  // --- Check 2: a CoD column with no `1` anchor (SAFe relative anchoring) ---
  if (scored.length >= thresholds.minTasksForSpread) {
    for (const key of COD_KEYS) {
      const hasAnchor = scored.some((s) => s.components[key] === 1);
      if (!hasAnchor) {
        findings.push({
          check: 'cod-no-anchor',
          severity: 'warning',
          message:
            `No task anchors the ${COL_LABEL[key]} column at 1. SAFe relative ` +
            `estimation requires the smallest item in each Cost-of-Delay column ` +
            `to be a 1 so the rest are anchored against it.`,
          suggestion:
            `Identify the lowest-${COL_LABEL[key]} task in the backlog and ` +
            `re-anchor it to 1, then rescore the column relative to that baseline.`,
          taskIds: scored.map((s) => s.taskId),
        });
      }
    }
  }

  // --- Check 3: Job Size collapsed to 1–2 (small-job bias) -----------------
  if (scored.length >= thresholds.minTasksForSpread) {
    const allTiny = scored.every((s) => s.components.jobSize <= 2);
    if (allTiny) {
      findings.push({
        check: 'job-size-collapsed',
        severity: 'warning',
        message:
          `Every scored task has a Job Size of 1 or 2. A backlog skewed entirely ` +
          `to tiny jobs means large work is being mis-sized down — and large work ` +
          `will starve because WSJF always favours the small denominator.`,
        suggestion:
          'Re-size jobs against the full {1,2,3,5,8,13} scale. If genuinely large ' +
          'work exists, give it an honest 8 or 13 so it competes for sequencing.',
        taskIds: scored.map((s) => s.taskId),
      });
    }
  }

  // --- Check 4: past-deadline but Time Criticality still high --------------
  const stale = scored.filter(
    (s) =>
      s.daysUntilDeadline !== null &&
      s.daysUntilDeadline < -thresholds.pastDeadlineDays &&
      s.components.timeCriticality >= thresholds.staleTcTier,
  );
  if (stale.length > 0) {
    findings.push({
      check: 'stale-time-criticality',
      severity: 'critical',
      message:
        `${stale.length} task(s) are past their deadline yet still carry a high ` +
        `Time Criticality (≥ ${thresholds.staleTcTier}). Once a deadline passes, ` +
        `Time Criticality is stale — it no longer reflects the real cost of delay.`,
      suggestion:
        'Rescore these tasks: either set a new deadline (and recompute Time ' +
        'Criticality) or drop Time Criticality to reflect that the window has closed.',
      taskIds: stale.map((s) => s.taskId),
    });
  }

  // --- Check 5: high fallback ratio (ready tasks with no WSJF score) -------
  const ready = snapshots.filter((s) => s.ready);
  if (ready.length >= thresholds.minReadyForFallback) {
    const unscored = ready.filter((s) => s.components === null);
    const ratio = unscored.length / ready.length;
    if (ratio >= thresholds.fallbackRatioCeiling) {
      findings.push({
        check: 'high-fallback-ratio',
        severity: 'warning',
        message:
          `${unscored.length} of ${ready.length} ready tasks ` +
          `(${Math.round(ratio * 100)}%) have no WSJF score and fall back to ` +
          `priority ordering. With most of the frontier unscored there is no WSJF ` +
          `reference frame — the ranking is really just priority.`,
        suggestion:
          'Set a project goal/charter and score the ready frontier so WSJF (not ' +
          'the priority fallback) drives sequencing.',
        taskIds: unscored.map((s) => s.taskId),
      });
    }
  }

  // --- Check 6: score-churn across rescore runs ----------------------------
  for (const snap of snapshots) {
    const points = historyByTask.get(snap.taskId);
    if (!points || points.length < 2) continue;
    // Consider only the score series produced by rescore runs across time. The
    // churn pitfall is a value that *flaps* — repeatedly reverses direction —
    // across consecutive rescases, signalling an unstable estimate.
    const series = points
      .filter((p) => p.isRescore && p.wsjfScore !== null)
      .map((p) => p.wsjfScore as number);
    if (series.length < 3) continue;
    let reversals = 0;
    let prevDir = 0;
    for (let i = 1; i < series.length; i++) {
      const cur = series[i];
      const prev = series[i - 1];
      if (cur === undefined || prev === undefined) continue;
      const delta = cur - prev;
      if (delta === 0) continue;
      const dir = delta > 0 ? 1 : -1;
      if (prevDir !== 0 && dir !== prevDir) reversals++;
      prevDir = dir;
    }
    if (reversals >= thresholds.churnReversals) {
      findings.push({
        check: 'score-churn',
        severity: 'info',
        message:
          `Task ${snap.taskId}'s WSJF score has reversed direction ${reversals} ` +
          `time(s) across ${series.length} rescores. A value that keeps flapping ` +
          `up and down is an unstable estimate — the score isn't converging.`,
        suggestion:
          'Stabilise the inputs: lock the components you are confident in, or ' +
          'revisit the charter/classification so successive rescores agree.',
        taskIds: [snap.taskId],
      });
    }
  }

  // --- Check 7: auto-sized tasks awaiting full CoD classification ----------
  const autoSizedPending = snapshots.filter((s) => s.autoSized);
  if (autoSizedPending.length > 0) {
    findings.push({
      check: 'auto-sized-pending',
      severity: 'info',
      message:
        `${autoSizedPending.length} task(s) are auto-sized (source=auto) awaiting ` +
        `full classification. Job Size was set by the server as a routing prior; ` +
        `the Cost-of-Delay components (Value, Time Criticality, Risk/Opportunity) ` +
        `have not been classified yet.`,
      suggestion:
        'Classify the Cost-of-Delay components for these tasks so they contribute ' +
        'a real WSJF score to the backlog ranking.',
      taskIds: autoSizedPending.map((s) => s.taskId),
    });
  }

  return {
    projectId,
    healthy: findings.length === 0,
    findings,
    scoredTaskCount: scored.length,
  };
}

/**
 * True when the task has a server-derived job size (`wsjf_source.jobSize === 'auto'`)
 * but the Cost-of-Delay numerator columns are still NULL — i.e., only the
 * size-only auto-write has run; no full classification has followed.
 */
function isAutoSizedPending(task: Task): boolean {
  return (
    task.wsjf_source?.jobSize === 'auto' &&
    (task.wsjf_value === null ||
      task.wsjf_time_criticality === null ||
      task.wsjf_risk_opportunity === null)
  );
}

/** Map a stored Task's INTEGER columns onto a `WsjfComponents` (or null). */
function componentsOf(task: Task): WsjfComponents | null {
  if (
    task.wsjf_value === null ||
    task.wsjf_time_criticality === null ||
    task.wsjf_risk_opportunity === null ||
    task.wsjf_job_size === null
  ) {
    return null;
  }
  return {
    value: task.wsjf_value,
    timeCriticality: task.wsjf_time_criticality,
    riskOpportunity: task.wsjf_risk_opportunity,
    jobSize: task.wsjf_job_size,
  };
}

/** Statuses that take a task OUT of the ready frontier (already terminal). */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'closed']);

/**
 * Collaborators the DB-backed linter needs. Injected (not constructed) so the
 * gatherer is testable over in-memory repositories — same pattern as
 * `RankDeps` / `WsjfRescoreDeps`. `tasks` supplies the rows; `history` is the
 * append-only `wsjf_score_history` reader (its rows feed the churn check). We
 * go through the repository that OWNS `wsjf_score_history` — never raw SQL.
 */
export interface WsjfHealthDeps {
  tasks: ITaskRepository;
  history: IWsjfHistoryRepository;
}

/**
 * DB-backed degeneracy linter. Loads a project's tasks + their score history
 * and delegates to the pure {@link analyzeWsjfHealth}. `now` is injectable so a
 * test can pin the clock for the past-deadline check.
 */
export class WsjfHealthService {
  constructor(private readonly deps: WsjfHealthDeps) {}

  /**
   * Lint a project's WSJF state. Returns a severity-tagged findings list (empty
   * ⇔ healthy). Pure read; writes nothing.
   */
  check(
    projectId: number,
    options: { now?: Date; thresholds?: WsjfHealthThresholds } = {},
  ): WsjfHealthReport {
    const now = options.now ?? new Date();
    const tasks = this.loadProjectTasks(projectId);

    const snapshots: HealthTaskSnapshot[] = tasks.map((t) => ({
      taskId: t.id,
      components: componentsOf(t),
      priority: t.priority,
      daysUntilDeadline: daysUntil(t.due_date, now),
      ready: !TERMINAL_STATUSES.has(t.status),
      autoSized: isAutoSizedPending(t),
    }));

    const historyByTask = new Map<number, HealthHistoryPoint[]>();
    for (const t of tasks) {
      const rows = this.deps.history.findByTaskId(t.id);
      if (rows.length === 0) continue;
      historyByTask.set(
        t.id,
        rows.map((r) => ({
          wsjfScore: r.wsjf_score,
          isRescore: r.trigger === 'rescore',
        })),
      );
    }

    return analyzeWsjfHealth(projectId, snapshots, historyByTask, options.thresholds);
  }

  /** Page through every task in the project (findByFilters clamps at 500). */
  private loadProjectTasks(projectId: number): Task[] {
    const expected = this.deps.tasks.count({ project_id: projectId });
    const out: Task[] = [];
    let offset = 0;
    while (out.length < expected) {
      const page = this.deps.tasks.findByFilters({
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
}

/** Whole-days from `now` until an ISO deadline (negative ⇒ past). Null-safe. */
function daysUntil(due: string | null, now: Date): number | null {
  if (!due) return null;
  const deadline = new Date(due);
  if (Number.isNaN(deadline.getTime())) return null;
  const ms = deadline.getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}
