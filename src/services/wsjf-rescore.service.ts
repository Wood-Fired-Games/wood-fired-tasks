// WSJF (Weighted Shortest Job First) — deterministic rescore orchestration.
//
// Task #641 (WSJF 4.1): the "living backlog" rescore engine. Phase 4 of the
// WSJF Prioritization milestone (plan task 4.1, design spec §8.4 / §11). After
// a project's value charter is re-interviewed (task 4.2), the backlog's already
// scored tasks must be re-evaluated against the NEW charter. This service is the
// deterministic, auditable chokepoint for that:
//
//   1. `collectRescoreSet(projectId)` returns the task set needing rescore plus
//      the charter and the per-task graph signals (transitive-dependent counts)
//      the caller needs to build a fresh `WsjfFeatures` for each task. Pure read.
//
//   2. `rescore(projectId, submissions, actor?)` accepts the written-back
//      classifications (one `ScoreSubmission` per task), recomputes every task's
//      four Fibonacci components DETERMINISTICALLY via
//      `validateScoreSubmission` (charter + features in → components out, no LLM,
//      no clock, no randomness), opens ONE `wsjf_rescore_run` record, writes one
//      `wsjf_score_history` row per CHANGED component-set linked by
//      `rescore_run_id`, SKIPS locked components (per-component `wsjf_locked`,
//      set by task 643), finalizes the run with rollup counts, and returns a
//      run summary. The component write, every history row, and the run record
//      commit in ONE `db.transaction(...)` so a partial rescore can never land.
//
// Determinism contract (spec §12): `rescore` is a pure function of
// `(charter, tasks, submissions)`. Given the same charter + tasks + submissions
// it always produces the same components, the same set of changed tasks, and the
// same history rows (modulo the auto-generated run id / timestamp). Locked
// components are byte-for-byte preserved.

import type { Database } from '../db/driver.js';
import type { ITaskRepository, IProjectRepository } from '../repositories/interfaces.js';
import type { IWsjfHistoryRepository } from '../repositories/wsjf-history.repository.js';
import type { IWsjfRescoreRepository } from '../repositories/wsjf-rescore.repository.js';
import type { Task, ValueCharter, WsjfWriteDTO } from '../types/task.js';
import type { WsjfComponents, WsjfComponentKey, WsjfLocks } from '../types/wsjf.js';
import type { TopologyService } from './topology.service.js';
import { computeWsjf, validateScoreSubmission, type ScoreSubmission } from './wsjf.service.js';
import { MAX_PAGE_LIMIT } from '../types/task.js';
import { BusinessError } from './errors.js';

/** The four component keys, in canonical order. */
const COMPONENT_KEYS: readonly WsjfComponentKey[] = [
  'value',
  'timeCriticality',
  'riskOpportunity',
  'jobSize',
];

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

/** Per-task graph signal the caller folds into a fresh `WsjfFeatures`. */
export interface RescoreGraphSignal {
  taskId: number;
  /** Distinct transitive dependents (DAG fan-out) — feeds Risk/Opportunity. */
  transitiveDependents: number;
}

/**
 * The read-side payload: everything the caller needs to produce written-back
 * classifications for a rescore. `tasks` is the set of currently-scored tasks
 * (the rescore candidates); `charter` is the project's CURRENT value charter (or
 * null for a charter-less project); `graphSignals` carries each task's
 * deterministic DAG fan-out.
 */
export interface RescoreSet {
  projectId: number;
  charter: ValueCharter | null;
  tasks: Task[];
  graphSignals: RescoreGraphSignal[];
}

/** One written-back classification per task, keyed by task id. */
export interface RescoreSubmission {
  taskId: number;
  submission: ScoreSubmission;
}

/** Optional actor attribution recorded on the run + history rows. */
export interface RescoreActor {
  actorType?: string | null;
  actorId?: string | null;
}

/** Per-task outcome inside a rescore run. */
export interface RescoreTaskResult {
  taskId: number;
  /** Did any unlocked component value actually change? */
  changed: boolean;
  /** Component keys preserved because they were locked. */
  skippedLocked: WsjfComponentKey[];
  /** The components AFTER the rescore (locked preserved, unlocked recomputed). */
  components: WsjfComponents;
  prevWsjfScore: number | null;
  newWsjfScore: number;
}

/** The run summary returned by {@link WsjfRescoreService.rescore}. */
export interface RescoreRunSummary {
  runId: number;
  projectId: number;
  tasksEvaluated: number;
  tasksChanged: number;
  tasksSkippedLocked: number;
  results: RescoreTaskResult[];
  /** Structured validation failures, keyed by task id (empty when all valid). */
  errors: { taskId: number; errors: string[] }[];
}

/**
 * Collaborators the rescore engine needs. Injected (not constructed) so the
 * service is unit-testable over in-memory repositories — same pattern as
 * `RankDeps`. The single `db` handle is shared with `history` + `runs` so the
 * whole rescore commits atomically.
 */
export interface WsjfRescoreDeps {
  db: Database;
  tasks: ITaskRepository;
  projects: IProjectRepository;
  history: IWsjfHistoryRepository;
  runs: IWsjfRescoreRepository;
  topology: TopologyService;
}

/**
 * Deterministic, auditable project rescore engine.
 */
export class WsjfRescoreService {
  constructor(private readonly deps: WsjfRescoreDeps) {}

  /**
   * Return the rescore candidate set: the project's currently-scored tasks, the
   * current charter, and each task's transitive-dependent count. Pure read; no
   * writes, no clock. Throws when the project does not exist or its graph is
   * cyclic (a cyclic graph has no well-defined fan-out closure — break it first).
   */
  collectRescoreSet(projectId: number): RescoreSet {
    const project = this.deps.projects.findById(projectId);
    if (!project) {
      throw new BusinessError(`Project with id ${projectId} does not exist`);
    }

    const report = this.deps.topology.classify(projectId);
    if (report.topology === 'DAG_CYCLIC') {
      throw new BusinessError(
        `Cannot rescore project ${projectId}: dependency graph is cyclic (DAG_CYCLIC); break the cycle first`,
      );
    }

    const allTasks = this.loadProjectTasks(projectId);
    // Only already-scored tasks are rescore candidates (an unscored task has
    // never been through the gate; the first score is a create/update, not a
    // rescore).
    const scored = allTasks.filter((t) => componentsOf(t) !== null);

    const transitiveDependents = this.computeTransitiveDependents(
      report.edges,
      allTasks.map((t) => t.id),
    );
    const graphSignals: RescoreGraphSignal[] = scored.map((t) => ({
      taskId: t.id,
      transitiveDependents: transitiveDependents.get(t.id) ?? 0,
    }));

    return {
      projectId,
      charter: project.value_charter,
      tasks: scored,
      graphSignals,
    };
  }

  /**
   * Deterministically rescore a project against its current charter using the
   * written-back classifications. Opens ONE run record, writes one history row
   * per CHANGED task linked by `rescore_run_id`, SKIPS locked components, and
   * returns a run summary. All writes commit in one transaction.
   *
   * Lock-skip: for each task, every component whose `wsjf_locked[key]` is true
   * keeps its PRIOR persisted value; only unlocked components take the freshly
   * recomputed value. A task whose four components are all locked is never
   * written (and counts as skipped, not changed).
   *
   * A submission that fails the deterministic gate is recorded in
   * `summary.errors` and contributes NO write — the rest of the batch still
   * commits (per-task isolation, not all-or-nothing on validation).
   */
  rescore(
    projectId: number,
    submissions: RescoreSubmission[],
    actor: RescoreActor = {},
  ): RescoreRunSummary {
    const project = this.deps.projects.findById(projectId);
    if (!project) {
      throw new BusinessError(`Project with id ${projectId} does not exist`);
    }
    const charter = project.value_charter;
    const charterVersion = charter?.interview_version ?? null;

    const submissionByTask = new Map<number, ScoreSubmission>();
    for (const s of submissions) submissionByTask.set(s.taskId, s.submission);

    // Recompute every submitted task BEFORE opening the run so a fully-invalid
    // batch opens no run row. Validation is pure; persistence happens after.
    interface Pending {
      task: Task;
      components: WsjfComponents;
      skippedLocked: WsjfComponentKey[];
      locked: WsjfLocks | null;
      submission: ScoreSubmission;
      changed: boolean;
      prevWsjfScore: number | null;
      newWsjfScore: number;
    }
    const pending: Pending[] = [];
    const errors: { taskId: number; errors: string[] }[] = [];

    for (const { taskId, submission } of submissions) {
      const task = this.deps.tasks.findById(taskId);
      if (!task || task.project_id !== projectId) {
        errors.push({
          taskId,
          errors: [`task ${taskId} is not a task in project ${projectId}`],
        });
        continue;
      }
      const prevComponents = componentsOf(task);
      if (prevComponents === null) {
        errors.push({
          taskId,
          errors: [`task ${taskId} is unscored; rescore only re-evaluates scored tasks`],
        });
        continue;
      }

      const verdict = validateScoreSubmission(submission, {
        charter,
        sourceText: this.sourceTextOf(task),
      });
      if (!verdict.ok || !verdict.components) {
        errors.push({ taskId, errors: verdict.errors });
        continue;
      }

      // Lock-skip: locked components keep their prior persisted value; only
      // unlocked components take the recomputed value (spec §8.4).
      const locked = task.wsjf_locked;
      const merged: WsjfComponents = { ...verdict.components };
      const skippedLocked: WsjfComponentKey[] = [];
      for (const key of COMPONENT_KEYS) {
        if (locked && locked[key]) {
          merged[key] = prevComponents[key];
          skippedLocked.push(key);
        }
      }

      const prevWsjfScore = computeWsjf(prevComponents);
      const newWsjfScore = computeWsjf(merged);
      const changed = COMPONENT_KEYS.some((key) => merged[key] !== prevComponents[key]);

      pending.push({
        task,
        components: merged,
        skippedLocked,
        locked,
        submission,
        changed,
        prevWsjfScore,
        newWsjfScore,
      });
    }

    const tasksEvaluated = pending.length;
    const changedPending = pending.filter((p) => p.changed);
    const skippedLockedCount = pending.filter((p) => p.skippedLocked.length > 0).length;

    // Open the run + write linked history + persist changed components, all in
    // one transaction. The run id is the FK every history row links by.
    const runId = this.deps.db.transaction(() => {
      const id = this.deps.runs.open({
        projectId,
        charterVersion,
        actorType: actor.actorType ?? null,
        actorId: actor.actorId ?? null,
      });

      for (const p of changedPending) {
        const wsjf: WsjfWriteDTO = {
          value: p.components.value,
          timeCriticality: p.components.timeCriticality,
          riskOpportunity: p.components.riskOpportunity,
          jobSize: p.components.jobSize,
          evidence: p.submission.classification.evidence,
          features: p.submission.features,
          classifications: p.submission.classification,
          // Preserve the existing per-component lock + source maps unchanged —
          // a rescore never alters which components are locked.
          locked: p.locked,
          source: p.task.wsjf_source,
        };
        this.deps.tasks.update(p.task.id, { wsjf });
        this.deps.history.append({
          taskId: p.task.id,
          projectId,
          trigger: 'rescore',
          value: p.components.value,
          timeCriticality: p.components.timeCriticality,
          riskOpportunity: p.components.riskOpportunity,
          jobSize: p.components.jobSize,
          wsjfScore: p.newWsjfScore,
          prevWsjfScore: p.prevWsjfScore,
          classifications: p.submission.classification,
          features: p.submission.features,
          evidence: p.submission.classification.evidence,
          source: p.task.wsjf_source,
          locked: p.locked,
          actorType: actor.actorType ?? null,
          actorId: actor.actorId ?? null,
          charterVersion,
          rescoreRunId: id,
        });
      }

      const summaryText =
        `rescored project ${projectId}: ${tasksEvaluated} evaluated, ` +
        `${changedPending.length} changed, ${skippedLockedCount} with locked components preserved`;
      this.deps.runs.finalize({
        runId: id,
        tasksEvaluated,
        tasksChanged: changedPending.length,
        tasksSkippedLocked: skippedLockedCount,
        summary: summaryText,
      });
      return id;
    })();

    const results: RescoreTaskResult[] = pending.map((p) => ({
      taskId: p.task.id,
      changed: p.changed,
      skippedLocked: p.skippedLocked,
      components: p.components,
      prevWsjfScore: p.prevWsjfScore,
      newWsjfScore: p.newWsjfScore,
    }));

    return {
      runId,
      projectId,
      tasksEvaluated,
      tasksChanged: changedPending.length,
      tasksSkippedLocked: skippedLockedCount,
      results,
      errors,
    };
  }

  /** Source text the evidence spans must be verbatim substrings of. */
  private sourceTextOf(task: Task): string {
    return [task.title, task.description ?? ''].join('\n');
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

  /**
   * Distinct transitive-dependent count per task via BFS over downstream edges
   * (edge {from,to}: `from` blocks `to`, so `to` is downstream). Diamond-safe:
   * each descendant counted once. Deterministic — no ordering dependence.
   */
  private computeTransitiveDependents(
    edges: ReadonlyArray<{ from: number; to: number }>,
    nodeIds: number[],
  ): Map<number, number> {
    const downstream = new Map<number, number[]>();
    for (const id of nodeIds) downstream.set(id, []);
    for (const e of edges) {
      if (!downstream.has(e.from)) downstream.set(e.from, []);
      downstream.get(e.from)!.push(e.to);
    }

    const counts = new Map<number, number>();
    for (const start of nodeIds) {
      const seen = new Set<number>([start]);
      const queue: number[] = [start];
      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        for (const next of downstream.get(cur) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      counts.set(start, seen.size - 1); // exclude self
    }
    return counts;
  }
}
