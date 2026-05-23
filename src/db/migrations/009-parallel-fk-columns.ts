import type Database from 'better-sqlite3';

/**
 * Migration 009: parallel FK columns on identity-carrying tables.
 *
 * Adds nullable INTEGER FK columns alongside the existing TEXT identity columns
 * (created_by, assignee, author). These columns stay NULL until Phase 31 backfill;
 * Phase 28 write paths will start populating them. Existing TEXT columns are
 * untouched until v1.7 sunset.
 *
 * Option A (per 27-RESEARCH.md section 1): exactly THREE columns. The
 * `task_claims` table does NOT exist in this codebase — claim ownership lives
 * on `tasks.assignee` (set by `TaskRepository.claimTask` in migration 004).
 * Therefore claim ownership rides on `tasks.assignee_user_id`; no separate
 * claimer-FK column is added.
 *
 * Patterns:
 * - ALTER TABLE ADD COLUMN with a FK to the users table — mirrors migration
 *   002's parent_task_id pattern. Default ON DELETE behavior (RESTRICT) is fine;
 *   we never delete users in v1.6.
 * - down() drops indexes BEFORE columns. SQLite refuses ALTER TABLE DROP COLUMN
 *   while an index still references the column (discovered in migration 002's
 *   roundtrip — see RESEARCH section 7 Pitfall 1).
 *
 * Note: `db.exec()` below is the better-sqlite3 Database.exec() method (executes
 * SQL on the connection). It is NOT child_process.exec — no shell involved.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE tasks
      ADD COLUMN created_by_user_id INTEGER REFERENCES users(id)
    `);

    db.exec(`
      ALTER TABLE tasks
      ADD COLUMN assignee_user_id INTEGER REFERENCES users(id)
    `);

    db.exec(`
      ALTER TABLE task_comments
      ADD COLUMN author_user_id INTEGER REFERENCES users(id)
    `);

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_created_by_user_id ON tasks(created_by_user_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_assignee_user_id ON tasks(assignee_user_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_task_comments_author_user_id ON task_comments(author_user_id)`
    );
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Drop indexes BEFORE columns — SQLite refuses DROP COLUMN while an index
    // still references the column (RESEARCH section 7 Pitfall 1).
    db.exec(`DROP INDEX IF EXISTS idx_tasks_created_by_user_id`);
    db.exec(`DROP INDEX IF EXISTS idx_tasks_assignee_user_id`);
    db.exec(`DROP INDEX IF EXISTS idx_task_comments_author_user_id`);

    db.exec(`ALTER TABLE tasks DROP COLUMN created_by_user_id`);
    db.exec(`ALTER TABLE tasks DROP COLUMN assignee_user_id`);
    db.exec(`ALTER TABLE task_comments DROP COLUMN author_user_id`);
  })();
}
