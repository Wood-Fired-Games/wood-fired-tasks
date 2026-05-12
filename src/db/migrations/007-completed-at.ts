import type Database from 'better-sqlite3';

/**
 * Migration 007: add completed_at column to tasks
 *
 * Purpose: support completion-report dashboards (task 97) that filter tasks
 * by when they entered the 'done' state.
 *
 * Semantics:
 * - completed_at is set when a task transitions INTO status='done'.
 * - Cleared (set NULL) when a task transitions OUT of 'done' (e.g., done -> open).
 * - 'closed' is intentionally not treated as completion — it's a separate
 *   archive/won't-do terminal state with different semantics in this codebase.
 *
 * Backfill: existing rows with status='done' get completed_at = updated_at as
 * the best available approximation. New rows are populated by the application
 * layer on the actual status transition.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`ALTER TABLE tasks ADD COLUMN completed_at TEXT`);

    // Backfill existing done rows with their last update timestamp.
    db.exec(`
      UPDATE tasks
      SET completed_at = updated_at
      WHERE status = 'done' AND completed_at IS NULL
    `);

    // Index for range queries on the completion-report dashboard.
    db.exec(`CREATE INDEX idx_tasks_completed_at ON tasks(completed_at)`);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`DROP INDEX IF EXISTS idx_tasks_completed_at`);
    db.exec(`ALTER TABLE tasks DROP COLUMN completed_at`);
  })();
}
