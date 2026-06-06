import type Database from '../driver.js';

/**
 * Migration 015: append-only WSJF audit tables.
 *
 * Part of Phase 1 of the WSJF Prioritization milestone (plan task 1.4,
 * design spec §4.3). Creates three append-only history tables that make every
 * WSJF value and every mid-project change traceable (spec §11):
 *
 *  - `wsjf_score_history`     — one immutable row per score write to a task.
 *  - `project_charter_history` — full charter snapshot per interview version.
 *  - `wsjf_rescore_run`       — one row per rescore event.
 *
 * Append-only intent: in normal flow these tables only ever receive INSERTs.
 * UPDATE/DELETE are forbidden by the repository layer (`wsjf-history.repository.ts`,
 * task 1.8) — NOT by SQLite triggers here, so the down-migration can still drop
 * the tables cleanly. Storing `classifications` + `features` (not just the
 * computed numbers) makes each score `f(stored inputs)` and enables replay
 * verification without the LLM (spec §12.5).
 *
 * FK SCOPE (critical): this migration references ONLY `tasks(id)` and
 * `projects(id)`. It deliberately does NOT reference `projects.value_charter`
 * (that column is added by sibling migration 014 in Phase 3) — charter content
 * is captured here as a self-contained JSON snapshot in
 * `project_charter_history.charter`, not via an FK.
 *
 * `rescore_run_id` on `wsjf_score_history` is a soft FK to `wsjf_rescore_run(id)`
 * created in the same migration, so ordering matters: `wsjf_rescore_run` is
 * created before `wsjf_score_history`.
 *
 * up()/down() are wrapped in `db.transaction(() => {...})()` to match the
 * project migration style (see 012). down() drops indexes before tables to
 * sidestep the SQLite "drop indexes before the objects they reference" pitfall.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Created first so wsjf_score_history.rescore_run_id can FK to it.
    db.exec(`
      CREATE TABLE wsjf_rescore_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
        charter_version INTEGER,
        actor_type TEXT,
        actor_id TEXT,
        tasks_evaluated INTEGER,
        tasks_changed INTEGER,
        tasks_skipped_locked INTEGER,
        summary TEXT
      )
    `);

    db.exec(`
      CREATE TABLE wsjf_score_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        trigger TEXT NOT NULL,
        actor_type TEXT,
        actor_id TEXT,
        charter_version INTEGER,
        rescore_run_id INTEGER REFERENCES wsjf_rescore_run(id) ON DELETE SET NULL,
        value INTEGER,
        time_criticality INTEGER,
        risk_opportunity INTEGER,
        job_size INTEGER,
        classifications TEXT,
        features TEXT,
        evidence TEXT,
        source TEXT,
        locked TEXT,
        wsjf_score REAL,
        prev_wsjf_score REAL
      )
    `);

    db.exec(`
      CREATE TABLE project_charter_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        interview_version INTEGER NOT NULL,
        charter TEXT NOT NULL,
        change_kind TEXT,
        actor_type TEXT,
        actor_id TEXT,
        changed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Indexes per plan task 1.4 / spec §4.3.
    db.exec(
      `CREATE INDEX idx_wsjf_score_history_task_changed
         ON wsjf_score_history(task_id, changed_at)`,
    );
    db.exec(
      `CREATE INDEX idx_wsjf_score_history_rescore_run
         ON wsjf_score_history(rescore_run_id)`,
    );
    db.exec(
      `CREATE INDEX idx_project_charter_history_project_version
         ON project_charter_history(project_id, interview_version)`,
    );
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Drop indexes before their tables.
    db.exec('DROP INDEX IF EXISTS idx_project_charter_history_project_version');
    db.exec('DROP INDEX IF EXISTS idx_wsjf_score_history_rescore_run');
    db.exec('DROP INDEX IF EXISTS idx_wsjf_score_history_task_changed');

    // Drop wsjf_score_history before wsjf_rescore_run (FK dependency order).
    db.exec('DROP TABLE IF EXISTS project_charter_history');
    db.exec('DROP TABLE IF EXISTS wsjf_score_history');
    db.exec('DROP TABLE IF EXISTS wsjf_rescore_run');
  })();
}
