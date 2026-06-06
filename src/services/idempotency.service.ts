import type Database from '../db/driver.js';

/**
 * IdempotencyService - prevents duplicate processing of requests
 * by caching responses keyed by client-provided idempotency keys.
 *
 * Uses the idempotency_keys table created by migration 004.
 * Keys expire after 24 hours.
 *
 * Defense-in-depth: in addition to the hourly cleanup scheduled in
 * `server.ts`, `set()` proactively trims expired rows once the table
 * grows beyond `MAX_ROWS_BEFORE_CLEANUP`. This bounds DB size even if
 * the periodic cleanup misfires or the server is under sustained load.
 */
export class IdempotencyService {
  /** Trigger an inline cleanup of expired rows when row count exceeds this. */
  static readonly MAX_ROWS_BEFORE_CLEANUP = 10_000;

  constructor(private db: Database.Database) {}

  /**
   * Check if an idempotency key exists and return cached response.
   * Returns null if key not found or expired (>24 hours).
   */
  get(key: string): object | null {
    const row = this.db
      .prepare(
        `SELECT response FROM idempotency_keys
       WHERE key = ? AND created_at > datetime('now', '-24 hours')`,
      )
      .get(key) as { response: string } | undefined;
    return row ? JSON.parse(row.response) : null;
  }

  /**
   * Store idempotency key with response for deduplication.
   *
   * If the table size exceeds `MAX_ROWS_BEFORE_CLEANUP` after the insert,
   * trigger a synchronous cleanup of expired rows. The cleanup only removes
   * rows already past the 24h TTL, so it cannot evict an in-flight key.
   */
  set(key: string, response: object): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO idempotency_keys (key, response) VALUES (?, ?)`)
      .run(key, JSON.stringify(response));

    const countRow = this.db.prepare(`SELECT COUNT(*) AS n FROM idempotency_keys`).get() as {
      n: number;
    };
    if (countRow.n > IdempotencyService.MAX_ROWS_BEFORE_CLEANUP) {
      this.cleanup();
    }
  }

  /**
   * Clean up expired keys (older than 24 hours).
   * Call periodically or on server startup.
   */
  cleanup(): number {
    const info = this.db
      .prepare(`DELETE FROM idempotency_keys WHERE created_at <= datetime('now', '-24 hours')`)
      .run();
    return info.changes;
  }
}
