import type Database from '../driver.js';

/**
 * Migration 021: the Archived project state.
 *
 * Design of record: docs/design/project-archived-state.md §2.1 and §3.1.
 *
 * Adds three nullable TEXT columns to `projects`:
 *  - `archived_at`    — ISO timestamp of the archive. A project is archived
 *    exactly when this is NOT NULL; there is no separate status column.
 *  - `archived_by`    — the authenticated caller that archived it.
 *  - `archive_reason` — optional free text (length is validated by
 *    `ArchiveProjectSchema` at the service boundary, not by a CHECK).
 *
 * No DEFAULT and no NOT NULL, so SQLite applies each ADD COLUMN as a
 * schema-table edit: no table rewrite, no backfill, and every existing row
 * reads the three columns as NULL — i.e. not archived.
 *
 * No index touches the columns, so the "drop indexes before columns" SQLite
 * pitfall does not apply to down().
 *
 * up()/down() are wrapped in `db.transaction(() => {...})()` to match the
 * project migration style (see 014/016/017).
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
    db.exec('ALTER TABLE projects ADD COLUMN archived_by TEXT');
    db.exec('ALTER TABLE projects ADD COLUMN archive_reason TEXT');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE projects DROP COLUMN archive_reason');
    db.exec('ALTER TABLE projects DROP COLUMN archived_by');
    db.exec('ALTER TABLE projects DROP COLUMN archived_at');
  })();
}
