import type Database from 'better-sqlite3';

/**
 * Migration 013: add WSJF (Weighted Shortest Job First) scoring columns to
 * the `tasks` table.
 *
 * Background (WSJF prioritization feature, project 30): tasks can carry a
 * WSJF score made of four Fibonacci-bucketed components plus structured JSON
 * metadata describing how that score was derived, who/what locked it, and the
 * provenance of the inputs.
 *
 * Storage shape:
 *  - Component columns (INTEGER, nullable):
 *      wsjf_value, wsjf_time_criticality, wsjf_risk_opportunity, wsjf_job_size
 *    Each is CHECK-constrained to the Fibonacci set {1,2,3,5,8,13}. NULL is
 *    always allowed (a SQLite CHECK passes when it evaluates to NULL), so
 *    legacy/unscored rows keep NULL. `wsjf_job_size` carries the same set but
 *    is additionally constrained `>= 1` to document that job size cannot be
 *    the lowest/zero bucket — for the Fibonacci set this is a no-op floor that
 *    makes the intent explicit in the schema.
 *  - Metadata columns (TEXT JSON, nullable):
 *      wsjf_evidence, wsjf_locked, wsjf_source, wsjf_classifications,
 *      wsjf_features
 *    JSON (de)serialization happens at the repository/service boundary
 *    (write: JSON.stringify; read: JSON.parse). Shape validation lives in the
 *    Zod schemas (`wsjf.schema.ts`), NOT as SQLite CHECKs — reproducing the
 *    shape here would double the truth and drift over time.
 *
 * Why column-level CHECKs instead of a table rebuild: SQLite's
 * `ALTER TABLE ... ADD COLUMN` accepts a column-level CHECK provided the
 * constraint does not reference other columns and the implicit default (NULL)
 * satisfies it. All five CHECKs here are self-referential and NULL-passing, so
 * a full table rebuild (the migration 005 pattern) is unnecessary. The CHECK
 * still rejects out-of-set inserts such as `wsjf_value = 4`.
 *
 * down() drops the five+four columns. No indexes touch them, so the SQLite
 * "drop indexes before columns" pitfall does not apply — but we still wrap
 * up()/down() in a transaction to match the project style.
 */

const FIB_CHECK = 'IN (1, 2, 3, 5, 8, 13)';

const INTEGER_COLUMNS: Array<{ name: string; check: string }> = [
  { name: 'wsjf_value', check: `wsjf_value ${FIB_CHECK}` },
  { name: 'wsjf_time_criticality', check: `wsjf_time_criticality ${FIB_CHECK}` },
  { name: 'wsjf_risk_opportunity', check: `wsjf_risk_opportunity ${FIB_CHECK}` },
  {
    name: 'wsjf_job_size',
    check: `wsjf_job_size ${FIB_CHECK} AND wsjf_job_size >= 1`,
  },
];

const TEXT_COLUMNS = [
  'wsjf_evidence',
  'wsjf_locked',
  'wsjf_source',
  'wsjf_classifications',
  'wsjf_features',
];

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    for (const { name, check } of INTEGER_COLUMNS) {
      db.exec(
        `ALTER TABLE tasks ADD COLUMN ${name} INTEGER CHECK (${check})`
      );
    }
    for (const name of TEXT_COLUMNS) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} TEXT`);
    }
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    for (const name of TEXT_COLUMNS) {
      db.exec(`ALTER TABLE tasks DROP COLUMN ${name}`);
    }
    for (const { name } of INTEGER_COLUMNS) {
      db.exec(`ALTER TABLE tasks DROP COLUMN ${name}`);
    }
  })();
}
