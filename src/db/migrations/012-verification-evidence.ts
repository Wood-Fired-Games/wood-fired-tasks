import type Database from '../driver.js';

/**
 * Migration 012: add `tasks.verification_evidence` column.
 *
 * Background (Wave 1.4 of the Tasks System Reliability milestone): we need a
 * structured place to record the outcome of post-close verification on a
 * task. Verifier subagents call `update_task` with a JSON envelope describing
 * the verdict (PASS / FAIL / PARTIAL / NOT_VERIFIED), a list of checks they
 * ran, and the verifier's session_id/request_id for traceability.
 *
 * Storage shape:
 *  {
 *    verdict: "PASS" | "FAIL" | "PARTIAL" | "NOT_VERIFIED",
 *    checks?: [{ name, status: "PASS"|"FAIL"|"SKIP", evidence_url_or_text }],
 *    verifier_session_id?: string,
 *    verifier_request_id?: string,
 *    verified_at?: string  // ISO8601
 *  }
 *
 * Design:
 *  - TEXT, nullable. The JSON serialization is performed at the
 *    repository boundary (write: JSON.stringify; read: JSON.parse).
 *  - No CHECK constraint — the enum / shape is validated by the Zod schema
 *    `VerificationEvidenceSchema` at the service boundary. Reproducing it as a
 *    SQLite CHECK would double the truth and fail-out-of-sync over time.
 *  - No index. The only query that filters on this column is `?verified=`,
 *    which uses json_extract on `$.verdict` and runs over the same row set
 *    as the existing list query (already paginated to LIMIT 500). At current
 *    scale (<10k rows) a scan is acceptable; revisit when we cross 100k.
 *  - Existing rows continue to load with a NULL value (back-compat).
 *  - Closing a task without explicit evidence materializes
 *    `{"verdict":"NOT_VERIFIED"}` at the service layer — that contract lives
 *    in `task.service.ts`, NOT here. The column itself remains nullable so
 *    legacy rows (and any future close path) can keep NULL.
 *
 * down() drops the column. No indexes touch this column, so the SQLite
 * "drop indexes before columns" pitfall does not apply — but we still wrap
 * up()/down() in a transaction to match the project style.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE tasks ADD COLUMN verification_evidence TEXT');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE tasks DROP COLUMN verification_evidence');
  })();
}
