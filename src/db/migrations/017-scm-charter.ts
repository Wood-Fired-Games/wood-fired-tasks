import type Database from '../driver.js';

/**
 * Migration 017: pluggable-SCM project charter default.
 *
 * Background (Pluggable Source Control, spec §6.3): the project charter gains an
 * optional `scm` default — a backend hint plus behavior-toggle defaults surfaced
 * on `get_project` as the precedence-2 fallback ONLY (a repo with no
 * `.tasks/scm.json` and no on-disk marker; §3.2). It never overrides an on-disk
 * signal. No new MCP tool is added.
 *
 * Storage shape (the authoritative TS contract / Zod validator is
 * `ScmCharterSchema` at the service boundary):
 *  - `projects.scm` TEXT NULL — per-project scm charter default JSON. Mirrors
 *    `projects.model_policy` (migration 016) and `projects.value_charter`
 *    (migration 014): TEXT, nullable; JSON serialization happens at the
 *    repository boundary (write: JSON.stringify; read: JSON.parse). No CHECK
 *    constraint — reproducing the charter shape as a SQLite CHECK would double
 *    the truth and drift. Existing rows continue to load with a NULL value
 *    (back-compat).
 *
 * No index touches the column — it is read by id alongside its row; there is no
 * query that filters on charter contents.
 *
 * up()/down() are wrapped in `db.transaction(() => {...})()` to match the
 * project migration style (see 014/016). down() drops the `projects.scm`
 * column. No indexes touch the column, so the "drop indexes before columns"
 * SQLite pitfall does not apply.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects ADD COLUMN scm TEXT');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects DROP COLUMN scm');
  })();
}
