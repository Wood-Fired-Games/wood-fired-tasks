import type Database from '../driver.js';

/**
 * Migration 019: tamper-EVIDENT hash chain over `audit_events`.
 *
 * Background (Security Audit finding M5, task #1636). Migration 018 gave the
 * audit trail tamper *resistance*: `BEFORE UPDATE` / `BEFORE DELETE` triggers
 * that `RAISE(ABORT, ...)`. Those triggers only bind a client going through
 * this schema — anyone who can write the SQLite file directly (or attach it
 * from a connection that drops the triggers first) can still rewrite history
 * undetected. This migration adds the missing half: every row carries a
 * SHA-256 hash over its own content PLUS the previous row's hash, so a
 * retroactive edit or a deleted row breaks the chain at a detectable point.
 *
 * Columns added:
 *  - `prev_hash` TEXT NULL — the `row_hash` of the immediately preceding row
 *    (by `id`), or the genesis constant (`AUDIT_CHAIN_GENESIS_HASH`, 64 '0'
 *    characters) for the very first row in the table.
 *  - `row_hash`  TEXT NULL — SHA-256 (hex) over a canonical, order-stable
 *    serialization of this row's content columns together with `prev_hash`.
 *
 * Why NULLABLE rather than `NOT NULL DEFAULT ''`:
 *  SQLite's `ALTER TABLE ... ADD COLUMN ... NOT NULL` requires a non-null
 *  DEFAULT, and any such default would be a value the chain verifier has to
 *  accept — i.e. a free pass for a row inserted directly, around the
 *  repository, with no hash. Leaving the columns nullable means an
 *  out-of-band INSERT lands NULLs, and NULL never equals a computed SHA-256,
 *  so `AuditEventRepository.verifyChain()` reports that row as the first
 *  break. Fail-closed by construction.
 *
 * Backfill: deliberately none. Nothing wrote `audit_events` before this
 * migration (018 created the table on this same unreleased branch; the REST
 * and MCP writers are tasks #1630/#1632 and go through the repository, which
 * has always populated the chain since #1636), so there are no legacy rows to
 * hash. Backfilling would additionally require dropping the append-only
 * triggers to run the UPDATEs — exactly the weakening this migration exists
 * to make detectable. If a pre-chain row somehow existed it would surface as
 * a chain break, which is the honest answer: an unhashed row is not covered
 * by the chain.
 *
 * The 018 triggers are NOT touched. SQLite's `ALTER TABLE ... ADD COLUMN`
 * does not require rebuilding the table or recreating triggers, and neither
 * trigger body references any column, so both survive up() and down()
 * verbatim with identical semantics.
 *
 * Chain computation lives entirely in `AuditEventRepository` (the exclusive
 * owner of this table's lifecycle) — see `computeAuditRowHash` /
 * `AUDIT_CHAIN_GENESIS_HASH` in `src/repositories/audit-event.repository.ts`.
 * No hashing logic is duplicated here.
 *
 * No index is added: the chain is verified by a single full walk in `id`
 * order, which the INTEGER PRIMARY KEY already serves.
 *
 * up()/down() are wrapped in `db.transaction(() => {...})()` per the
 * 017/018 convention. down() drops the columns in reverse order; neither is
 * referenced by an index or a trigger, so SQLite's `DROP COLUMN`
 * restrictions do not apply.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE audit_events ADD COLUMN prev_hash TEXT');
    db.exec('ALTER TABLE audit_events ADD COLUMN row_hash TEXT');
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('ALTER TABLE audit_events DROP COLUMN row_hash');
    db.exec('ALTER TABLE audit_events DROP COLUMN prev_hash');
  })();
}
