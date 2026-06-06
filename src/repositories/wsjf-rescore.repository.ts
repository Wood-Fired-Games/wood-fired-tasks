import type Database from '../db/driver.js';
import { mapRow } from './row-mapper.js';

/**
 * WSJF (task #641): writer + reader over the `wsjf_rescore_run` table
 * (created by migration 015, task #624).
 *
 * Contract (design spec §4.3 / §8.4): every deterministic rescore of a project
 * opens EXACTLY ONE `wsjf_rescore_run` row. Each `wsjf_score_history` row the
 * rescore appends FKs back to that run via `wsjf_score_history.rescore_run_id`
 * (a soft FK — `ON DELETE SET NULL`), so the full set of component changes a
 * single rescore produced is queryable by `rescore_run_id`. The run row carries
 * the rollup counts (`tasks_evaluated`, `tasks_changed`, `tasks_skipped_locked`)
 * and a human `summary`.
 *
 * Lifecycle: {@link open} inserts the run row up-front (returning its id) so the
 * history appends can reference it inside the SAME transaction; {@link finalize}
 * writes back the rollup counts once the rescore loop has run. Both are issued
 * through the caller-supplied `Database.Database` handle so a
 * `db.transaction(() => { open(); ...history.append(); finalize(); })()` commits
 * the run record, every linked history row, and the component writes atomically.
 *
 * Unlike {@link WsjfHistoryRepository}, this table is NOT append-only: `finalize`
 * UPDATEs the counts of the run row it just opened. The row is still immutable in
 * spirit (one logical rescore event) — `finalize` only fills in the rollup that
 * is only knowable after the loop completes.
 */

const RESCORE_RUN_TABLE = 'wsjf_rescore_run';

/** Inputs known when a rescore run is opened (before the loop runs). */
export interface OpenRescoreRunInput {
  projectId: number;
  charterVersion?: number | null;
  actorType?: string | null;
  actorId?: string | null;
}

/** Rollup counts written back once the rescore loop has completed. */
export interface FinalizeRescoreRunInput {
  runId: number;
  tasksEvaluated: number;
  tasksChanged: number;
  tasksSkippedLocked: number;
  summary?: string | null;
}

/** A `wsjf_rescore_run` row as read back. */
export interface WsjfRescoreRunRow {
  id: number;
  project_id: number;
  triggered_at: string;
  charter_version: number | null;
  actor_type: string | null;
  actor_id: string | null;
  tasks_evaluated: number | null;
  tasks_changed: number | null;
  tasks_skipped_locked: number | null;
  summary: string | null;
}

export interface IWsjfRescoreRepository {
  /** Open a run record (counts NULL until {@link finalize}). Returns its id. */
  open(input: OpenRescoreRunInput): number;
  /** Write back the rollup counts + summary for an opened run. */
  finalize(input: FinalizeRescoreRunInput): void;
  /** Read a run row by id (null when absent). */
  findById(runId: number): WsjfRescoreRunRow | null;
}

export class WsjfRescoreRepository implements IWsjfRescoreRepository {
  private readonly openStmt: Database.Statement;
  private readonly finalizeStmt: Database.Statement;
  private readonly findByIdStmt: Database.Statement;

  /**
   * @param db the better-sqlite3 handle. Pass the SAME connection the rescore
   *   service writes history + components through so the whole rescore commits
   *   in one transaction.
   */
  constructor(private readonly db: Database.Database) {
    this.openStmt = db.prepare(`
      INSERT INTO ${RESCORE_RUN_TABLE} (
        project_id, charter_version, actor_type, actor_id
      ) VALUES (
        @project_id, @charter_version, @actor_type, @actor_id
      )
    `);
    this.finalizeStmt = db.prepare(`
      UPDATE ${RESCORE_RUN_TABLE}
         SET tasks_evaluated = @tasks_evaluated,
             tasks_changed = @tasks_changed,
             tasks_skipped_locked = @tasks_skipped_locked,
             summary = @summary
       WHERE id = @id
    `);
    this.findByIdStmt = db.prepare(`SELECT * FROM ${RESCORE_RUN_TABLE} WHERE id = ?`);
  }

  open(input: OpenRescoreRunInput): number {
    const info = this.openStmt.run({
      project_id: input.projectId,
      charter_version: input.charterVersion ?? null,
      actor_type: input.actorType ?? null,
      actor_id: input.actorId ?? null,
    });
    return info.lastInsertRowid as number;
  }

  finalize(input: FinalizeRescoreRunInput): void {
    this.finalizeStmt.run({
      id: input.runId,
      tasks_evaluated: input.tasksEvaluated,
      tasks_changed: input.tasksChanged,
      tasks_skipped_locked: input.tasksSkippedLocked,
      summary: input.summary ?? null,
    });
  }

  findById(runId: number): WsjfRescoreRunRow | null {
    const row = mapRow<Record<string, unknown>>(this.findByIdStmt, runId);
    if (!row) return null;
    return {
      id: row.id as number,
      project_id: row.project_id as number,
      triggered_at: row.triggered_at as string,
      charter_version: (row.charter_version as number | null) ?? null,
      actor_type: (row.actor_type as string | null) ?? null,
      actor_id: (row.actor_id as string | null) ?? null,
      tasks_evaluated: (row.tasks_evaluated as number | null) ?? null,
      tasks_changed: (row.tasks_changed as number | null) ?? null,
      tasks_skipped_locked: (row.tasks_skipped_locked as number | null) ?? null,
      summary: (row.summary as string | null) ?? null,
    };
  }
}
