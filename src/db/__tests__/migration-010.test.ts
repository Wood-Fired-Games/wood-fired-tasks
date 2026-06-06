import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 010: partial UNIQUE indexes that back the
 * boot-time seeder's idempotency (WR-04 of 27-REVIEW.md).
 *
 * Verifies:
 * - Both partial UNIQUE indexes exist with the expected WHERE predicate.
 * - The legacy partial UNIQUE rejects a second is_legacy=1 row with the same
 *   display_name (the seeder's intent: at most one legacy row per name).
 * - The service-account partial UNIQUE rejects a second is_service_account=1
 *   row with the same display_name (intent: at most one slack-bot).
 * - The partial predicate does NOT block non-legacy / non-service rows with
 *   the same display_name (so an OIDC user can share a display_name with a
 *   legacy user, etc.).
 * - down() drops both indexes; up() after down() restores them.
 */
describe('Migration 010: identity uniqueness indexes', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('creates idx_users_legacy_display_name as a partial UNIQUE on (display_name) WHERE is_legacy = 1', () => {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_users_legacy_display_name'",
      )
      .get() as { sql: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.sql).toBeTruthy();
    expect(row?.sql).toContain('UNIQUE');
    expect(row?.sql).toContain('display_name');
    expect(row?.sql).toContain('WHERE');
    expect(row?.sql).toContain('is_legacy = 1');
  });

  it('creates idx_users_slack_bot as a partial UNIQUE on (display_name) WHERE is_service_account = 1', () => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_users_slack_bot'")
      .get() as { sql: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.sql).toBeTruthy();
    expect(row?.sql).toContain('UNIQUE');
    expect(row?.sql).toContain('display_name');
    expect(row?.sql).toContain('WHERE');
    expect(row?.sql).toContain('is_service_account = 1');
  });

  it('legacy partial UNIQUE rejects a second is_legacy=1 row with the same display_name', () => {
    db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('alice');

    expect(() =>
      db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('alice'),
    ).toThrow(/UNIQUE/i);
  });

  it('service-account partial UNIQUE rejects a second is_service_account=1 row with the same display_name', () => {
    db.prepare(`INSERT INTO users (display_name, is_service_account) VALUES (?, 1)`).run(
      'slack-bot',
    );

    expect(() =>
      db
        .prepare(`INSERT INTO users (display_name, is_service_account) VALUES (?, 1)`)
        .run('slack-bot'),
    ).toThrow(/UNIQUE/i);
  });

  it('legacy partial UNIQUE does NOT block a non-legacy row with the same display_name', () => {
    // A legacy user and an OIDC user can share a display_name — the partial
    // predicate `WHERE is_legacy = 1` means rows with is_legacy=0 are
    // outside the index domain entirely.
    db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('shared-name');

    expect(() =>
      db
        .prepare(
          `INSERT INTO users (display_name, oidc_provider, oidc_sub, is_legacy)
           VALUES (?, ?, ?, 0)`,
        )
        .run('shared-name', 'google', 'shared-name-sub'),
    ).not.toThrow();

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE display_name = ?`)
      .get('shared-name') as { c: number };
    expect(count.c).toBe(2);
  });

  it('service-account partial UNIQUE does NOT block a non-service row with the same display_name', () => {
    db.prepare(`INSERT INTO users (display_name, is_service_account) VALUES (?, 1)`).run(
      'slack-bot',
    );

    expect(() =>
      db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('slack-bot'),
    ).not.toThrow();

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM users WHERE display_name = ?`)
      .get('slack-bot') as { c: number };
    expect(count.c).toBe(2);
  });

  it('down() drops both partial UNIQUE indexes', async () => {
    const { down } = await import('../migrations/010-identity-uniqueness-indexes.js');
    await down(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_users_legacy_display_name','idx_users_slack_bot')",
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(0);
  });

  it('up() after down() restores both partial UNIQUE indexes (round-trip)', async () => {
    const before = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE name IN ('idx_users_legacy_display_name','idx_users_slack_bot')
         ORDER BY name`,
      )
      .all();

    const { up, down } = await import('../migrations/010-identity-uniqueness-indexes.js');
    await down(db);
    await up(db);

    const after = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE name IN ('idx_users_legacy_display_name','idx_users_slack_bot')
         ORDER BY name`,
      )
      .all();

    expect(after).toEqual(before);
  });
});
