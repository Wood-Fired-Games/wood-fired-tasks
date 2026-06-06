import type Database from '../db/driver.js';
import type { ValueCharter } from '../types/task.js';
import { mapRow, mapRows } from './row-mapper.js';
import { AppendOnlyViolationError } from './errors.js';

/**
 * WSJF (task #642, WSJF 4.2): append-only writer + reader for the
 * `project_charter_history` table (created by migration 015, task #624).
 *
 * Contract (design spec §11 / §4.3): the table is IMMUTABLE. When the charter
 * interview is re-run and an existing (non-null) charter is overwritten, the
 * PRIOR charter is snapshotted here as a self-contained JSON blob before the
 * new charter lands. Each snapshot records the `interview_version` the new
 * charter bumped to, so the history reads as "this was the charter that was
 * REPLACED when version N was written".
 *
 * Append-only is enforced HERE in code (not by SQLite triggers — that keeps the
 * 015 down-migration able to drop the table cleanly): {@link update} and
 * {@link delete} always raise {@link AppendOnlyViolationError} and never issue
 * SQL. This mirrors `WsjfHistoryRepository`.
 *
 * The writer shares the caller's `Database.Database` handle so the prior-charter
 * snapshot and the charter overwrite (a `projects` UPDATE) commit atomically
 * inside one `db.transaction(...)` — a charter overwrite can never land without
 * its history row, and vice versa.
 */

/** One append-only charter-history snapshot. */
export interface ProjectCharterHistoryRecord {
  projectId: number;
  /** The interview version the snapshot is associated with (the bumped one). */
  interviewVersion: number;
  /** The PRIOR charter being replaced, stored verbatim as a JSON snapshot. */
  charter: ValueCharter;
  /** Why the snapshot was taken — defaults to `overwrite`. */
  changeKind?: string | null;
  actorType?: string | null;
  actorId?: string | null;
}

/** A charter-history row as read back (JSON `charter` column parsed). */
export interface ProjectCharterHistoryRow {
  id: number;
  project_id: number;
  interview_version: number;
  charter: ValueCharter | null;
  change_kind: string | null;
  actor_type: string | null;
  actor_id: string | null;
  changed_at: string;
}

export interface IProjectCharterHistoryRepository {
  /** Append one immutable charter snapshot. Returns the new row id. */
  append(record: ProjectCharterHistoryRecord): number;
  /** Read a project's charter history, oldest-first (changed_at, id ascending). */
  findByProjectId(projectId: number): ProjectCharterHistoryRow[];
  /** Count charter-history rows for a project. */
  countByProjectId(projectId: number): number;
  /** ALWAYS throws — the table is append-only. */
  update(...args: unknown[]): never;
  /** ALWAYS throws — the table is append-only. */
  delete(...args: unknown[]): never;
}

const CHARTER_HISTORY_TABLE = 'project_charter_history';

/** Defensive JSON parse for a TEXT column (non-JSON → null, never throws). */
function parseCharter(raw: unknown): ValueCharter | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as ValueCharter;
  } catch {
    return null;
  }
}

export class ProjectCharterHistoryRepository implements IProjectCharterHistoryRepository {
  private readonly insertStmt: Database.Statement;
  private readonly findByProjectIdStmt: Database.Statement;
  private readonly countByProjectIdStmt: Database.Statement;

  /**
   * @param db the better-sqlite3 handle. Pass the SAME connection the
   *   `projects` UPDATE writes through so an enclosing `db.transaction(...)`
   *   commits the snapshot and the charter overwrite atomically.
   */
  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO ${CHARTER_HISTORY_TABLE} (
        project_id, interview_version, charter, change_kind, actor_type, actor_id
      ) VALUES (
        @project_id, @interview_version, @charter, @change_kind, @actor_type, @actor_id
      )
    `);
    this.findByProjectIdStmt = db.prepare(
      `SELECT * FROM ${CHARTER_HISTORY_TABLE} WHERE project_id = ? ORDER BY changed_at ASC, id ASC`,
    );
    this.countByProjectIdStmt = db.prepare(
      `SELECT COUNT(*) as count FROM ${CHARTER_HISTORY_TABLE} WHERE project_id = ?`,
    );
  }

  append(record: ProjectCharterHistoryRecord): number {
    const info = this.insertStmt.run({
      project_id: record.projectId,
      interview_version: record.interviewVersion,
      charter: JSON.stringify(record.charter),
      change_kind: record.changeKind ?? 'overwrite',
      actor_type: record.actorType ?? null,
      actor_id: record.actorId ?? null,
    });
    return info.lastInsertRowid as number;
  }

  findByProjectId(projectId: number): ProjectCharterHistoryRow[] {
    const rows = mapRows<Record<string, unknown>>(this.findByProjectIdStmt, projectId);
    return rows.map((row) => ({
      id: row['id'] as number,
      project_id: row['project_id'] as number,
      interview_version: row['interview_version'] as number,
      charter: parseCharter(row['charter']),
      change_kind: (row['change_kind'] as string | null) ?? null,
      actor_type: (row['actor_type'] as string | null) ?? null,
      actor_id: (row['actor_id'] as string | null) ?? null,
      changed_at: row['changed_at'] as string,
    }));
  }

  countByProjectId(projectId: number): number {
    const result = mapRow<{ count: number }>(this.countByProjectIdStmt, projectId);
    return result?.count ?? 0;
  }

  update(): never {
    throw new AppendOnlyViolationError(CHARTER_HISTORY_TABLE, 'UPDATE');
  }

  delete(): never {
    throw new AppendOnlyViolationError(CHARTER_HISTORY_TABLE, 'DELETE');
  }
}
