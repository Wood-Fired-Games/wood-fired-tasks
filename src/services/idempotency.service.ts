import type Database from 'better-sqlite3';

/**
 * IdempotencyService - prevents duplicate processing of requests
 * by caching responses keyed by client-provided idempotency keys.
 *
 * Uses the idempotency_keys table created by migration 004.
 * Keys expire after 24 hours.
 */
export class IdempotencyService {
  constructor(private db: Database.Database) {}

  /**
   * Check if an idempotency key exists and return cached response.
   * Returns null if key not found or expired (>24 hours).
   */
  get(key: string): object | null {
    const row = this.db.prepare(
      `SELECT response FROM idempotency_keys
       WHERE key = ? AND created_at > datetime('now', '-24 hours')`
    ).get(key) as { response: string } | undefined;
    return row ? JSON.parse(row.response) : null;
  }

  /**
   * Store idempotency key with response for deduplication.
   */
  set(key: string, response: object): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO idempotency_keys (key, response) VALUES (?, ?)`
    ).run(key, JSON.stringify(response));
  }

  /**
   * Clean up expired keys (older than 24 hours).
   * Call periodically or on server startup.
   */
  cleanup(): number {
    const info = this.db.prepare(
      `DELETE FROM idempotency_keys WHERE created_at <= datetime('now', '-24 hours')`
    ).run();
    return info.changes;
  }
}
