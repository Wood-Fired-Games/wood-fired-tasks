import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdempotencyService } from '../idempotency.service.js';
import { initTestDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import type Database from '../../db/driver.js';

/**
 * Dedicated behavioural test for the 24-hour TTL contract enforced in
 * `IdempotencyService` (see `idempotency.service.ts`):
 *
 *   WHERE key = ? AND created_at > datetime('now', '-24 hours')
 *
 * Rows are inserted directly with manual `created_at` so we exercise the
 * exact boundary the service enforces, independent of insert timing.
 *
 * Covers (per task 210 acceptance criteria):
 *  - `get()` returns null for an expired key BEFORE cleanup runs
 *    (TTL is applied on read, not only by the cleanup job).
 *  - `cleanup()` removes ONLY rows past the 24h boundary; rows within
 *    the window (e.g. 23h old) survive.
 */
describe('IdempotencyService TTL + cleanup boundary', () => {
  let db: Database.Database;
  let service: IdempotencyService;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
    service = new IdempotencyService(db);
  });

  afterEach(() => {
    db.close();
  });

  /** Insert a row with a manually-set `created_at` offset (sqlite datetime modifier). */
  function insertAged(key: string, response: object, sqliteOffset: string): void {
    db.prepare(
      `INSERT INTO idempotency_keys (key, response, created_at)
       VALUES (?, ?, datetime('now', ?))`,
    ).run(key, JSON.stringify(response), sqliteOffset);
  }

  function rowExists(key: string): boolean {
    const row = db.prepare(`SELECT 1 AS hit FROM idempotency_keys WHERE key = ?`).get(key) as
      | { hit: number }
      | undefined;
    return row?.hit === 1;
  }

  it('get() returns null for expired key BEFORE cleanup runs (read-time TTL filter)', () => {
    insertAged('expired-25h', { stale: true }, '-25 hours');

    // Row physically exists in the table...
    expect(rowExists('expired-25h')).toBe(true);

    // ...but get() must filter it out via the 24h WHERE clause without
    // requiring cleanup() to have run first.
    expect(service.get('expired-25h')).toBeNull();
  });

  it('cleanup() removes only rows past the 24h boundary; rows inside the window survive', () => {
    insertAged('expired-25h', { stale: true }, '-25 hours');
    insertAged('fresh-23h', { stale: false }, '-23 hours');

    // Sanity: both rows are present before cleanup.
    expect(rowExists('expired-25h')).toBe(true);
    expect(rowExists('fresh-23h')).toBe(true);

    // Pre-cleanup read semantics: expired hidden, fresh visible.
    expect(service.get('expired-25h')).toBeNull();
    expect(service.get('fresh-23h')).toEqual({ stale: false });

    const removed = service.cleanup();

    // Exactly one row (the 25h one) should be evicted.
    expect(removed).toBe(1);
    expect(rowExists('expired-25h')).toBe(false);
    expect(rowExists('fresh-23h')).toBe(true);

    // Post-cleanup read semantics are unchanged for the surviving key.
    expect(service.get('fresh-23h')).toEqual({ stale: false });
    expect(service.get('expired-25h')).toBeNull();
  });
});
