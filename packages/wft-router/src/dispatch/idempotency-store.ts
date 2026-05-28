/**
 * Idempotency store + PENDING/SUCCEEDED dispatch state machine for the
 * wft-router (task #425).
 *
 * One row per `(rule_name, event_id)` records the lifecycle of a dispatch:
 * PENDING is written BEFORE the handler runs; a terminal status
 * (SUCCEEDED / FAILED / PERMANENTLY_FAILED / SUPERSEDED) is written AFTER
 * the handler returns. See docs/event-router-design.md §"At-least-once
 * dispatch protocol" (lines 383-403) and §"Idempotency" (lines 405-414)
 * for the design-of-record.
 *
 * **AC vs spec discrepancy.** Task #425's acceptance criteria say "SQLite
 * file lands under the resolved data dir", but the spec's outputs list
 * (docs/event-router-design.md line 112) places `idempotency.sqlite` under
 * the STATE dir. The spec is authoritative (passed three review cycles)
 * so the canonical path is `getPaths().state + '/idempotency.sqlite'`.
 * The constructor accepts a `dbPath` so test suites and the future
 * `--rebuild-idempotency` code path can override it.
 *
 * Durability story (spec §"Storage durability", lines 457-468): the store
 * is opened with `journal_mode=WAL` and `synchronous=NORMAL`. WAL +
 * NORMAL gives us the post-PENDING / pre-cursor-advance ordering WFT-NEUTRALITY-EXEMPT-LINE
 * guarantee without manual fsync calls — better-sqlite3 promotes the
 * write to the WAL synchronously, and a checkpoint on commit flushes it
 * to the main file at transaction boundaries.
 *
 * Atomicity: every multi-statement transition (claim's
 * read-then-conditionally-insert; replayPending's mark-abandoned +
 * select-survivors) is wrapped in `db.transaction()` so concurrent
 * callers on the same `(rule_name, event_id)` cannot both write a fresh
 * PENDING row. The acceptance criterion is explicit on this requirement.
 *
 * Standalone-package isolation: no imports from root `src/`. The
 * better-sqlite3 native module is resolved transitively from the root's
 * hoisted node_modules at runtime and is also re-declared in this
 * package's `dependencies` block as a publish-surface declaration (task
 * #439).
 */

import BetterSqlite from 'better-sqlite3';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The dispatch state machine. `PENDING` is the only non-terminal state.
 * `SUCCEEDED`, `FAILED`, `PERMANENTLY_FAILED`, and `SUPERSEDED` all halt
 * the per-row lifecycle. (`FAILED` is retried at a higher layer up to
 * `max_retries`; once retries are exhausted the row is rewritten as
 * `PERMANENTLY_FAILED` — that's a caller-side decision, not the store's.)
 */
export type DispatchStatus =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'PERMANENTLY_FAILED'
  | 'SUPERSEDED';

/**
 * Result of a `claim()` attempt. The store is the single source of truth
 * for whether a fresh dispatch should fire — callers do not consult
 * status fields directly.
 */
export type ClaimResult =
  | { kind: 'CLAIMED' }
  | { kind: 'ALREADY_PENDING' }
  | { kind: 'ALREADY_DONE'; status: DispatchStatus };

/**
 * Row shape returned by `replayPending()`. Caller is responsible for
 * re-rendering the trigger's `with:` block from `rendered_with_json` and
 * re-firing the action. Secondary-key fields are nullable because
 * pre-#427 events may not carry a task_id / to_status tuple.
 */
export interface PendingRow {
  rule_name: string;
  event_id: string;
  rendered_with_json: string;
  started_at_ms: number;
  task_id: number | null;
  to_status: string | null;
  emitted_at_minute: number | null;
}

/**
 * Constructor options. `dbPath` is mandatory because the wiring layer
 * (task #433) is the one that owns path resolution via `getPaths().state`.
 * `idempotencyWindowMs` defaults to 3600 s — the same default used by
 * `idempotency_window_s` in the trigger schema (spec §"Trigger config
 * schema").
 */
export interface IdempotencyStoreOptions {
  dbPath: string;
  /** PENDING rows older than this are abandoned on replay. Default: 3600 * 1000 ms. */
  idempotencyWindowMs?: number;
  /** Injectable clock — same Date.now()-ish shape used by the SSE client. Default: Date.now. */
  now?: () => number;
}

/**
 * Wraps the SQLITE_CORRUPT error class that better-sqlite3 surfaces
 * when the db file is unreadable. The daemon-level wiring (task #433)
 * matches on this and exits 5 with the spec-mandated message; this module
 * just exposes the discriminator so the catch site stays declarative.
 */
export class IdempotencyStoreCorruptError extends Error {
  public override readonly cause: unknown;
  public readonly code = 'SQLITE_CORRUPT';

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'IdempotencyStoreCorruptError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// SQL schema (single source of truth — kept inline for ease of audit).
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dispatch_log (
  rule_name           TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  status              TEXT NOT NULL,
  rendered_with_json  TEXT NOT NULL,
  started_at_ms       INTEGER NOT NULL,
  completed_at_ms     INTEGER,
  task_id             INTEGER,
  to_status           TEXT,
  emitted_at_minute   INTEGER,
  PRIMARY KEY (rule_name, event_id)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_secondary
  ON dispatch_log (rule_name, task_id, to_status, emitted_at_minute);
CREATE INDEX IF NOT EXISTS idx_dispatch_pending
  ON dispatch_log (status, started_at_ms);
`;

// ---------------------------------------------------------------------------
// Internal types — what better-sqlite3 hands back from .get() / .all().
// ---------------------------------------------------------------------------

interface ExistingStatusRow {
  status: DispatchStatus;
}

interface DbPendingRow {
  rule_name: string;
  event_id: string;
  rendered_with_json: string;
  started_at_ms: number;
  task_id: number | null;
  to_status: string | null;
  emitted_at_minute: number | null;
}

interface SecondaryHitRow {
  event_id: string;
}

interface NativeSqliteError {
  code?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Default idempotency window — mirrors the spec's `idempotency_window_s: 3600`. */
const DEFAULT_WINDOW_MS = 3600 * 1000;

/** Convert an `emitted_at` ms-since-epoch into the minute-bucket used by the secondary key. */
function minuteBucket(emittedAtMs: number): number {
  return Math.floor(emittedAtMs / 60_000);
}

/**
 * Inspect a thrown value to decide whether it's the SQLITE_CORRUPT
 * case. better-sqlite3 surfaces native sqlite errors with a `code`
 * property; older versions sometimes only set the message. We accept
 * either signal so the daemon-level catch never sees a raw SqliteError
 * when the file is malformed.
 */
function isSqliteCorrupt(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const e = err as NativeSqliteError;
  if (e.code === 'SQLITE_CORRUPT') {
    return true;
  }
  if (typeof e.message === 'string' && e.message.includes('database disk image is malformed')) {
    return true;
  }
  return false;
}

export class IdempotencyStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly idempotencyWindowMs: number;

  // Prepared statements (mirrors a sibling repository's prior-art pattern).
  private readonly selectByPkStmt: Database.Statement;
  private readonly insertPendingStmt: Database.Statement;
  private readonly updateToTerminalStmt: Database.Statement;
  private readonly selectPendingWithinWindowStmt: Database.Statement;
  private readonly markStaleAbandonedStmt: Database.Statement;
  private readonly selectBySecondaryKeyStmt: Database.Statement;

  /**
   * Opens (or creates) the sqlite file at `opts.dbPath`, applies the
   * required pragmas, ensures the schema exists, and prepares all reused
   * statements. Throws {@link IdempotencyStoreCorruptError} when the file
   * is unreadable; the daemon catches this and exits 5 per spec.
   */
  constructor(opts: IdempotencyStoreOptions) {
    let db: Database.Database;
    try {
      db = new BetterSqlite(opts.dbPath);
    } catch (err) {
      if (isSqliteCorrupt(err)) {
        throw new IdempotencyStoreCorruptError(
          `idempotency store at ${opts.dbPath} is corrupt`,
          err,
        );
      }
      throw err;
    }

    this.db = db;
    this.now = opts.now ?? Date.now;
    this.idempotencyWindowMs = opts.idempotencyWindowMs ?? DEFAULT_WINDOW_MS;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(SCHEMA_SQL);

    this.selectByPkStmt = this.db.prepare(
      'SELECT status FROM dispatch_log WHERE rule_name = ? AND event_id = ?',
    );
    this.insertPendingStmt = this.db.prepare(
      `INSERT INTO dispatch_log (
         rule_name, event_id, status, rendered_with_json, started_at_ms,
         completed_at_ms, task_id, to_status, emitted_at_minute
       ) VALUES (?, ?, 'PENDING', ?, ?, NULL, ?, ?, ?)`,
    );
    this.updateToTerminalStmt = this.db.prepare(
      `UPDATE dispatch_log
         SET status = ?, completed_at_ms = ?
       WHERE rule_name = ? AND event_id = ? AND status = 'PENDING'`,
    );
    this.selectPendingWithinWindowStmt = this.db.prepare(
      `SELECT rule_name, event_id, rendered_with_json, started_at_ms,
              task_id, to_status, emitted_at_minute
         FROM dispatch_log
        WHERE status = 'PENDING' AND started_at_ms >= ?
        ORDER BY started_at_ms ASC`,
    );
    this.markStaleAbandonedStmt = this.db.prepare(
      `UPDATE dispatch_log
         SET status = 'PERMANENTLY_FAILED', completed_at_ms = ?
       WHERE status = 'PENDING' AND started_at_ms < ?`,
    );
    this.selectBySecondaryKeyStmt = this.db.prepare(
      `SELECT event_id FROM dispatch_log
        WHERE rule_name = ?
          AND task_id = ?
          AND to_status = ?
          AND emitted_at_minute = ?
          AND status = 'SUCCEEDED'
        LIMIT 1`,
    );
  }

  /**
   * Atomically claim `(rule_name, event_id)` for dispatch. Wrapped in
   * `db.transaction()` so concurrent claims for the same key cannot both
   * insert — the second caller sees the PENDING row written by the first.
   *
   * - Returns `{ kind: 'CLAIMED' }` and writes a fresh PENDING row when
   *   no prior row exists.
   * - Returns `{ kind: 'ALREADY_PENDING' }` when another caller already
   *   owns the dispatch (the row exists but no terminal status yet).
   * - Returns `{ kind: 'ALREADY_DONE', status }` when a terminal row
   *   exists. Callers MUST suppress re-dispatch in that case — this is
   *   the SSE-redelivery dedup contract.
   */
  claim(input: {
    rule_name: string;
    event_id: string;
    rendered_with_json: string;
    task_id: number | null;
    to_status: string | null;
    emitted_at_ms: number | null;
  }): ClaimResult {
    const tx = this.db.transaction((args: typeof input): ClaimResult => {
      const existing = this.selectByPkStmt.get(args.rule_name, args.event_id) as
        | ExistingStatusRow
        | undefined;
      if (existing !== undefined) {
        return existing.status === 'PENDING'
          ? { kind: 'ALREADY_PENDING' }
          : { kind: 'ALREADY_DONE', status: existing.status };
      }
      this.insertPendingStmt.run(
        args.rule_name,
        args.event_id,
        args.rendered_with_json,
        this.now(),
        args.task_id,
        args.to_status,
        args.emitted_at_ms === null ? null : minuteBucket(args.emitted_at_ms),
      );
      return { kind: 'CLAIMED' };
    });
    return tx(input);
  }

  /**
   * Transition a PENDING row to a terminal status. No-op (returns false)
   * if the row does not exist or is already terminal — this keeps the
   * caller's "complete is idempotent" invariant without a separate guard
   * query.
   */
  complete(rule_name: string, event_id: string, status: DispatchStatus): boolean {
    if (status === 'PENDING') {
      // The store is the source of truth for non-terminal status; refuse
      // to "complete" a row back to PENDING.
      return false;
    }
    const info = this.updateToTerminalStmt.run(status, this.now(), rule_name, event_id);
    return info.changes > 0;
  }

  /**
   * Crash-replay entry point. Inside a single transaction:
   *
   *   1. Every PENDING row older than `idempotencyWindowMs` is marked
   *      PERMANENTLY_FAILED (spec §"Crash reconciliation" calls these
   *      "abandoned with a WARN"; the WARN lives in the caller because
   *      this module owns sqlite I/O only, not logging).
   *   2. The remaining PENDING rows — those still within the window —
   *      are returned to the caller for re-firing.
   */
  replayPending(): PendingRow[] {
    const cutoff = this.now() - this.idempotencyWindowMs;
    const tx = this.db.transaction((): PendingRow[] => {
      this.markStaleAbandonedStmt.run(this.now(), cutoff);
      const rows = this.selectPendingWithinWindowStmt.all(cutoff) as DbPendingRow[];
      return rows.map((r) => ({
        rule_name: r.rule_name,
        event_id: r.event_id,
        rendered_with_json: r.rendered_with_json,
        started_at_ms: r.started_at_ms,
        task_id: r.task_id,
        to_status: r.to_status,
        emitted_at_minute: r.emitted_at_minute,
      }));
    });
    return tx();
  }

  /**
   * Defense-in-depth lookup keyed on `(rule_name, task_id, to_status,
   * minute_bucket)`. Returns the `event_id` of an existing SUCCEEDED row
   * matching the tuple, or null. Caller uses this when the upstream
   * event lacks a stable `event_id` — e.g. polling fallback — and needs
   * to coalesce a re-delivery without collapsing legitimate
   * `closed → reopened → closed` cycles that straddle a minute boundary.
   */
  lookupBySecondaryKey(input: {
    rule_name: string;
    task_id: number;
    to_status: string;
    emitted_at_ms: number;
  }): string | null {
    const row = this.selectBySecondaryKeyStmt.get(
      input.rule_name,
      input.task_id,
      input.to_status,
      minuteBucket(input.emitted_at_ms),
    ) as SecondaryHitRow | undefined;
    return row?.event_id ?? null;
  }

  /**
   * Release the sqlite handle. Idempotent — calling on an
   * already-closed db is a no-op so tests can defensively close in
   * teardown without tracking which branches opened it.
   */
  close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}
