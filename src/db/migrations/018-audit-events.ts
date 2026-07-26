import type Database from '../driver.js';

/**
 * Migration 018: append-only audit_events table.
 *
 * Foundation for the audit-trail chain (Security Audit finding M5). This
 * table is written to by #1629 (repository with a typed append API), #1630
 * (REST lifecycle hook), and #1632 (stdio MCP mutations); #1636 layers a hash
 * chain on top and #1637 adds the read surface. Getting the column set right
 * here matters — all five downstream tasks depend on it.
 *
 * Columns (per the audit spec):
 *  - `timestamp`     TEXT NOT NULL, defaults to now. When the event occurred.
 *  - `actor_type`    TEXT NOT NULL. Kind of actor performing the action (e.g.
 *                    'user', 'service_account', 'system'). Left as free-form
 *                    TEXT rather than a CHECK enum — the authoritative set of
 *                    actor kinds lives at the service boundary (mirrors the
 *                    `scm`/`model_policy`/`value_charter` precedent of not
 *                    duplicating shape validation in SQLite).
 *  - `actor_id`      TEXT NOT NULL. Identifier of the actor (user id, service
 *                    account id, etc). TEXT so it can hold either a numeric
 *                    user id or an opaque string id without a schema split.
 *  - `token_id`      TEXT NULL. The API token (if any) used to authenticate
 *                    the request. Nullable because not every action is
 *                    token-authenticated (e.g. an interactive session).
 *  - `action`        TEXT NOT NULL. The action performed (e.g.
 *                    'task.create', 'task.update').
 *  - `resource_type` TEXT NOT NULL. Kind of resource acted upon (e.g. 'task',
 *                    'project').
 *  - `resource_id`   TEXT NULL. Identifier of the resource. Nullable because
 *                    some actions (e.g. a failed auth attempt) have no
 *                    resolved resource.
 *  - `request_id`    TEXT NULL. Correlates the audit row back to the request
 *                    that produced it (HTTP request id / MCP call id).
 *  - `metadata`      TEXT NULL. Free-form JSON blob for action-specific
 *                    detail. JSON serialization happens at the repository
 *                    boundary (write: JSON.stringify; read: JSON.parse) — no
 *                    CHECK constraint, matching the `value_charter` /
 *                    `model_policy` / `scm` convention elsewhere in this
 *                    schema.
 *
 * No column here assumes an answer to the still-open #1630 design question
 * (whether an audit append is written in the same transaction as the
 * mutation it records, or is best-effort/non-fatal to the response) — that
 * is a call-site concern for #1630, not a schema concern.
 *
 * Indexes:
 *  - `idx_audit_events_timestamp` on `timestamp` — supports time-ordered /
 *    time-ranged reads (the primary access pattern for an audit log).
 *  - `idx_audit_events_resource` on `(resource_type, resource_id)` —
 *    supports "show me the audit trail for this resource" lookups.
 *
 * Append-only enforcement:
 *  Two `BEFORE UPDATE` / `BEFORE DELETE` triggers `RAISE(ABORT, ...)` to
 *  reject any attempt to mutate or remove an existing row at the SQLite
 *  layer. IMPORTANT — this is tamper *resistance*, not tamper *evidence*:
 *  it stops a well-behaved client (or a buggy query) going through the
 *  driver from mutating history, but anyone with direct write access to the
 *  SQLite file (or who can open it without going through this trigger-
 *  bearing schema) can still rewrite rows undetected. Making tampering
 *  detectable is #1636's hash chain, not this migration — do not treat the
 *  triggers here as a substitute for that.
 *
 * up()/down() are wrapped in `db.transaction(() => {})()` per the 017
 * convention. down() drops triggers and indexes before the table (explicit,
 * matching 008's convention) even though DROP TABLE would clean them up
 * anyway, keeping the migrations-roundtrip schema-snapshot deterministic.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        token_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        request_id TEXT,
        metadata TEXT
      )
    `);

    db.exec(`
      CREATE INDEX idx_audit_events_timestamp ON audit_events(timestamp)
    `);

    db.exec(`
      CREATE INDEX idx_audit_events_resource ON audit_events(resource_type, resource_id)
    `);

    // Append-only enforcement: reject UPDATE/DELETE against existing rows.
    // See the tamper-resistance-vs-tamper-evidence note above the export.
    db.exec(`
      CREATE TRIGGER audit_events_no_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE is not permitted');
      END
    `);

    db.exec(`
      CREATE TRIGGER audit_events_no_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only: DELETE is not permitted');
      END
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_delete');
    db.exec('DROP TRIGGER IF EXISTS audit_events_no_update');
    db.exec('DROP INDEX IF EXISTS idx_audit_events_resource');
    db.exec('DROP INDEX IF EXISTS idx_audit_events_timestamp');
    db.exec('DROP TABLE IF EXISTS audit_events');
  })();
}
