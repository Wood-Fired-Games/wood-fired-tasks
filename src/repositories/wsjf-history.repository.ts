import type Database from 'better-sqlite3';
import type {
  WsjfEvidence,
  WsjfLocks,
  WsjfSource,
  WsjfClassification,
  WsjfFeatures,
  WsjfHistoryTrigger,
} from '../types/wsjf.js';
// Re-exported from the leaf `types` module so this repository keeps its public
// surface (`WSJF_HISTORY_TRIGGERS` / `WsjfHistoryTrigger`) while schemas can
// import the constant without an upstream-layer edge (depcruise
// `leaves-no-upstream`).
export { WSJF_HISTORY_TRIGGERS } from '../types/wsjf.js';
export type { WsjfHistoryTrigger } from '../types/wsjf.js';
import { mapRow, mapRows } from './row-mapper.js';
import { AppendOnlyViolationError } from './errors.js';

/**
 * WSJF (task #628): append-only repository over the `wsjf_score_history` table
 * (created by migration 015, task #624).
 *
 * Contract (design spec §11): the table is IMMUTABLE. Every WSJF write to a
 * task — create-with-score, update-with-score, future manual override / rescore
 * — appends exactly one row recording the four server-computed components, the
 * raw classification + deterministic features they were derived from, the
 * evidence/source/lock metadata, and the `prev_wsjf_score` (the task's WSJF
 * BEFORE this write, or null on the first scoring). Storing the inputs (not
 * just the number) makes every score replayable as `f(classifications, features)`
 * without the LLM (spec §12.5).
 *
 * Append-only is enforced HERE in code (not by SQLite triggers — that keeps the
 * 015 down-migration able to drop the table cleanly): {@link update} and
 * {@link delete} always raise {@link AppendOnlyViolationError} and never issue
 * SQL.
 *
 * The writer accepts an optional `Database.Database` handle so the caller
 * (task.service) can pass the SAME connection that is mid-transaction. With one
 * better-sqlite3 connection a `db.transaction(() => { repo.create(); history.append(); })()`
 * commits both writes atomically — no component write can land without its
 * history row.
 */


/**
 * One append-only history write. Components + score are the server-computed
 * truth; `classifications` / `features` / `evidence` / `source` / `locked` are
 * the structured metadata behind them. `prevWsjfScore` is the task's WSJF
 * BEFORE this write (null on first scoring). Optional provenance / linkage
 * fields default to null when omitted.
 */
export interface WsjfHistoryRecord {
  taskId: number;
  projectId: number;
  trigger: WsjfHistoryTrigger;
  value: number | null;
  timeCriticality: number | null;
  riskOpportunity: number | null;
  jobSize: number | null;
  wsjfScore: number | null;
  prevWsjfScore: number | null;
  classifications?: WsjfClassification | null;
  features?: WsjfFeatures | null;
  evidence?: WsjfEvidence | null;
  source?: WsjfSource | null;
  locked?: WsjfLocks | null;
  actorType?: string | null;
  actorId?: string | null;
  charterVersion?: number | null;
  rescoreRunId?: number | null;
}

/** A history row as read back from `wsjf_score_history` (JSON columns parsed). */
export interface WsjfHistoryRow {
  id: number;
  task_id: number;
  project_id: number;
  changed_at: string;
  trigger: WsjfHistoryTrigger;
  actor_type: string | null;
  actor_id: string | null;
  charter_version: number | null;
  rescore_run_id: number | null;
  value: number | null;
  time_criticality: number | null;
  risk_opportunity: number | null;
  job_size: number | null;
  classifications: WsjfClassification | null;
  features: WsjfFeatures | null;
  evidence: WsjfEvidence | null;
  source: WsjfSource | null;
  locked: WsjfLocks | null;
  wsjf_score: number | null;
  prev_wsjf_score: number | null;
}

/**
 * Append-only writer + history reader for `wsjf_score_history`.
 *
 * @see AppendOnlyViolationError for the mutation guard.
 */
export interface IWsjfHistoryRepository {
  /** Append one immutable history row. Returns the new row id. */
  append(record: WsjfHistoryRecord): number;
  /** Read a task's history, oldest-first (changed_at, id ascending). */
  findByTaskId(taskId: number): WsjfHistoryRow[];
  /** Count history rows for a task. */
  countByTaskId(taskId: number): number;
  /** ALWAYS throws — the table is append-only. */
  update(...args: unknown[]): never;
  /** ALWAYS throws — the table is append-only. */
  delete(...args: unknown[]): never;
}

const HISTORY_TABLE = 'wsjf_score_history';

/** Serialize a JSON metadata member; undefined/null both persist as NULL. */
function serialize(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Defensive JSON parse for a TEXT column (non-JSON → null, never throws). */
function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class WsjfHistoryRepository implements IWsjfHistoryRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByTaskIdStmt: Database.Statement;
  private readonly countByTaskIdStmt: Database.Statement;

  /**
   * @param db the better-sqlite3 handle. Pass the SAME connection that the
   *   task repository writes through so an enclosing `db.transaction(...)`
   *   commits the component write and the history append atomically.
   */
  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO ${HISTORY_TABLE} (
        task_id, project_id, trigger, actor_type, actor_id, charter_version,
        rescore_run_id, value, time_criticality, risk_opportunity, job_size,
        classifications, features, evidence, source, locked,
        wsjf_score, prev_wsjf_score
      ) VALUES (
        @task_id, @project_id, @trigger, @actor_type, @actor_id, @charter_version,
        @rescore_run_id, @value, @time_criticality, @risk_opportunity, @job_size,
        @classifications, @features, @evidence, @source, @locked,
        @wsjf_score, @prev_wsjf_score
      )
    `);
    this.findByTaskIdStmt = db.prepare(
      `SELECT * FROM ${HISTORY_TABLE} WHERE task_id = ? ORDER BY changed_at ASC, id ASC`,
    );
    this.countByTaskIdStmt = db.prepare(
      `SELECT COUNT(*) as count FROM ${HISTORY_TABLE} WHERE task_id = ?`,
    );
  }

  append(record: WsjfHistoryRecord): number {
    const info = this.insertStmt.run({
      task_id: record.taskId,
      project_id: record.projectId,
      trigger: record.trigger,
      actor_type: record.actorType ?? null,
      actor_id: record.actorId ?? null,
      charter_version: record.charterVersion ?? null,
      rescore_run_id: record.rescoreRunId ?? null,
      value: record.value,
      time_criticality: record.timeCriticality,
      risk_opportunity: record.riskOpportunity,
      job_size: record.jobSize,
      classifications: serialize(record.classifications),
      features: serialize(record.features),
      evidence: serialize(record.evidence),
      source: serialize(record.source),
      locked: serialize(record.locked),
      wsjf_score: record.wsjfScore,
      prev_wsjf_score: record.prevWsjfScore,
    });
    return info.lastInsertRowid as number;
  }

  findByTaskId(taskId: number): WsjfHistoryRow[] {
    const rows = mapRows<Record<string, unknown>>(this.findByTaskIdStmt, taskId);
    return rows.map((row) => ({
      id: row.id as number,
      task_id: row.task_id as number,
      project_id: row.project_id as number,
      changed_at: row.changed_at as string,
      trigger: row.trigger as WsjfHistoryTrigger,
      actor_type: (row.actor_type as string | null) ?? null,
      actor_id: (row.actor_id as string | null) ?? null,
      charter_version: (row.charter_version as number | null) ?? null,
      rescore_run_id: (row.rescore_run_id as number | null) ?? null,
      value: (row.value as number | null) ?? null,
      time_criticality: (row.time_criticality as number | null) ?? null,
      risk_opportunity: (row.risk_opportunity as number | null) ?? null,
      job_size: (row.job_size as number | null) ?? null,
      classifications: parseJson<WsjfClassification>(row.classifications),
      features: parseJson<WsjfFeatures>(row.features),
      evidence: parseJson<WsjfEvidence>(row.evidence),
      source: parseJson<WsjfSource>(row.source),
      locked: parseJson<WsjfLocks>(row.locked),
      wsjf_score: (row.wsjf_score as number | null) ?? null,
      prev_wsjf_score: (row.prev_wsjf_score as number | null) ?? null,
    }));
  }

  countByTaskId(taskId: number): number {
    const result = mapRow<{ count: number }>(this.countByTaskIdStmt, taskId);
    return result?.count ?? 0;
  }

  /**
   * Append-only guard. The history table is immutable; mutating an existing
   * audit row would destroy the traceability the table exists to provide.
   * Always throws {@link AppendOnlyViolationError}; never issues SQL.
   */
  update(): never {
    throw new AppendOnlyViolationError(HISTORY_TABLE, 'UPDATE');
  }

  /** Append-only guard — see {@link update}. */
  delete(): never {
    throw new AppendOnlyViolationError(HISTORY_TABLE, 'DELETE');
  }
}
