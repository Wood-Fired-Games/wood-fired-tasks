import type Database from '../driver.js';

/**
 * Migration 014: add `projects.value_charter` column.
 *
 * Background (WSJF Prioritization, Phase 3.1): the WSJF scoring system needs
 * a per-project "value charter" — the autonomous reference frame an agent
 * uses to score User-Business Value relative to the project's mission and
 * ranked value themes. The charter is produced by the project-interview flow
 * (see `skills/tasks/new-project.md`) and persisted on the parent project.
 *
 * Storage shape (the authoritative TS contract is `ValueCharter` in
 * `src/types/task.ts`; the Zod validator is `ValueCharterSchema` in
 * `src/schemas/project.schema.ts`):
 *  {
 *    mission: string,
 *    value_themes: [{ name, weight: Fib, description }],
 *    time_context: string,
 *    risk_posture: string,
 *    out_of_scope: string[],
 *    interview_version: number,
 *    updated_at: string  // ISO8601
 *  }
 *
 * Design (mirrors migration 012's `tasks.verification_evidence`):
 *  - TEXT, nullable. JSON serialization happens at the repository boundary
 *    (write: JSON.stringify; read: JSON.parse).
 *  - No CHECK constraint — the theme-weight Fibonacci enum and the rest of
 *    the shape are validated by `ValueCharterSchema` at the service boundary.
 *    Reproducing it as a SQLite CHECK would double the truth and drift.
 *  - No index. Charters are read by id alongside the project row; there is no
 *    query that filters on the charter contents.
 *  - Existing rows continue to load with a NULL value (back-compat).
 *
 * down() drops the column. No indexes touch it, so the "drop indexes before
 * columns" SQLite pitfall does not apply — but we still wrap up()/down() in a
 * transaction to match the project style.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects ADD COLUMN value_charter TEXT');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects DROP COLUMN value_charter');
  })();
}
