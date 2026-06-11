import type Database from '../driver.js';

/**
 * Migration 016: configurable task models.
 *
 * Background (Configurable Task Models, Task 3): the model-selection system
 * needs a per-project model policy plus a database-wide default, so an agent
 * dispatching a task can resolve which Claude model to run under (project
 * override falling back to the global default).
 *
 * Storage shape (the authoritative TS contract / Zod validator is
 * `ModelPolicySchema` at the service boundary):
 *  - `projects.model_policy` TEXT NULL — per-project ModelPolicy JSON. Mirrors
 *    `projects.value_charter` (migration 014): TEXT, nullable; JSON
 *    serialization happens at the repository boundary (write: JSON.stringify;
 *    read: JSON.parse). No CHECK constraint — reproducing the policy shape as a
 *    SQLite CHECK would double the truth and drift. Existing rows continue to
 *    load with a NULL value (back-compat).
 *  - `app_settings` (id=1 singleton) with `model_policy_default` TEXT NULL —
 *    the database-wide default policy. The `CHECK (id = 1)` pins the table to a
 *    single canonical row; that constraint is on the integer PK, NOT on the
 *    JSON payload. Seeded with one row (id=1, model_policy_default NULL) so the
 *    repository always has a row to read/update.
 *
 * No index touches either column — both are read by id alongside their row;
 * there is no query that filters on policy contents.
 *
 * up()/down() are wrapped in `db.transaction(() => {...})()` to match the
 * project migration style (see 014/015). down() drops the `app_settings` table
 * first, then the `projects.model_policy` column. No indexes touch the column,
 * so the "drop indexes before columns" SQLite pitfall does not apply.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects ADD COLUMN model_policy TEXT');
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         model_policy_default TEXT
       )`,
    );
    db.exec('INSERT OR IGNORE INTO app_settings (id, model_policy_default) VALUES (1, NULL)');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS app_settings');
    db.exec('ALTER TABLE projects DROP COLUMN model_policy');
  })();
}
