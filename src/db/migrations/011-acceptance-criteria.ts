import type Database from 'better-sqlite3';

/**
 * Migration 011: add `tasks.acceptance_criteria` column.
 *
 * Background (Wave 1.3 of the Tasks System Reliability milestone): today a
 * task's "what would prove this is done?" content lives unstructured inside
 * the free-form `description` field. Promoting it to a dedicated nullable
 * TEXT column makes it addressable by every write surface (REST, MCP, CLI)
 * without losing back-compat with the (very) large set of existing rows
 * that have no such content.
 *
 * Design:
 *  - TEXT, nullable. No CHECK constraint — the field is plain markdown.
 *  - No index. There is no query pattern that filters by acceptance content;
 *    the column is heavy free-form text and would only ever appear in
 *    full-task projections.
 *  - Length bounding lives in the Zod schema layer (max 5000 chars), matching
 *    the existing `description` cap.
 *  - Phase 27 contract: existing rows continue to load with a NULL value.
 *
 * down() drops the column. No indexes touch this column, so the SQLite
 * "drop indexes before columns" pitfall (migration 002/009 RESEARCH section
 * 7) does not apply — but we still wrap up()/down() in a transaction to
 * match the project style.
 *
 * Note: the database statements below are run through better-sqlite3's
 * Database method that executes SQL on the connection. No shell is involved.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE tasks
      ADD COLUMN acceptance_criteria TEXT
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`ALTER TABLE tasks DROP COLUMN acceptance_criteria`);
  })();
}
