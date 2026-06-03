/**
 * Repository-layer error classes.
 *
 * These errors are internal to the data-access layer. Services are expected to
 * catch and translate them into domain errors (e.g. ValidationError) before
 * letting them cross out of the repository boundary.
 */

/**
 * FtsSyntaxError — thrown when a SQLite FTS5 MATCH query fails to parse the
 * user-supplied search expression.
 *
 * The original SQLite error message is preserved on the instance so the
 * service layer can log it for operators, but it must NEVER be surfaced to
 * clients verbatim (it leaks internal parser details).
 */
export class FtsSyntaxError extends Error {
  public override readonly name = 'FtsSyntaxError';
  public readonly originalMessage: string;

  constructor(originalMessage: string) {
    super('FTS5 search expression failed to parse');
    this.originalMessage = originalMessage;

    // Restore prototype chain for instanceof checks across module boundaries.
    Object.setPrototypeOf(this, FtsSyntaxError.prototype);
  }
}

/**
 * AppendOnlyViolationError — thrown when a caller attempts to UPDATE or DELETE
 * a row in an append-only audit table (e.g. `wsjf_score_history`).
 *
 * WSJF task #628: the score-history table is immutable by contract (design
 * spec §11 — every score and mid-project change must stay traceable). The
 * repository enforces this in code rather than via SQLite triggers (so the
 * 015 down-migration can still drop the table cleanly). Any mutation method on
 * the history repository raises this instead of issuing SQL.
 */
export class AppendOnlyViolationError extends Error {
  public override readonly name = 'AppendOnlyViolationError';
  public readonly table: string;
  public readonly operation: 'UPDATE' | 'DELETE';

  constructor(table: string, operation: 'UPDATE' | 'DELETE') {
    super(
      `${operation} is not permitted on append-only table "${table}"; ` +
        'history rows are immutable',
    );
    this.table = table;
    this.operation = operation;

    // Restore prototype chain for instanceof checks across module boundaries.
    Object.setPrototypeOf(this, AppendOnlyViolationError.prototype);
  }
}

/**
 * Detect whether a raw error from better-sqlite3 is an FTS5 syntax error.
 *
 * Pattern: SQLITE_ERROR with a message that contains FTS-specific phrases.
 * Matches the audit-confirmed cases (`"`, `NEAR(`, `*`) plus the typical
 * SQLite FTS5 error texts (`fts5:`, `unterminated string`,
 * `unknown special query`, `unterminated phrase`, `parse error`).
 */
export function isSqliteFtsSyntaxError(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== 'string' || code !== 'SQLITE_ERROR') return false;
  const msg = e.message ?? '';
  return (
    msg.includes('fts5:') ||
    msg.includes('unterminated string') ||
    msg.includes('unknown special query') ||
    msg.includes('unterminated phrase') ||
    msg.includes('parse error') ||
    msg.includes('no such column')
  );
}
