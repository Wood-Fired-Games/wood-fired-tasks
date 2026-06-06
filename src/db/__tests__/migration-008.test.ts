import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 008: identity tables (users, api_tokens).
 *
 * Verifies:
 * - Exact column sets for users and api_tokens via PRAGMA table_info.
 * - Partial unique indexes on (oidc_provider, oidc_sub) and slack_user_id
 *   carry the `WHERE ... IS NOT NULL` predicate (first partial unique
 *   indexes in this codebase).
 * - Unique index on api_tokens.hash + non-unique index on api_tokens.user_id.
 * - Partial unique on (oidc_provider, oidc_sub) permits multiple (NULL, NULL)
 *   rows AND rejects duplicate non-null (provider, sub) pairs.
 * - api_tokens.user_id FK ON DELETE CASCADE.
 * - down() drops all four indexes and both tables; up() after down() restores.
 */
describe('Migration 008: Identity Tables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initTestDatabase();
  });

  it('creates users table with expected columns', async () => {
    await runMigrations(db);

    const cols = db.prepare("PRAGMA table_info('users')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();

    expect(names).toEqual(
      [
        'id',
        'oidc_sub',
        'oidc_provider',
        'email',
        'display_name',
        'slack_user_id',
        'is_legacy',
        'is_service_account',
        'created_at',
        'disabled_at',
      ].sort(),
    );
  });

  it('creates api_tokens table with expected columns', async () => {
    await runMigrations(db);

    const cols = db.prepare("PRAGMA table_info('api_tokens')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();

    expect(names).toEqual(
      [
        'id',
        'user_id',
        'name',
        'prefix',
        'suffix',
        'hash',
        'scopes',
        'created_at',
        'last_used_at',
        'revoked_at',
        'expires_at',
      ].sort(),
    );
  });

  it('creates partial unique index on (oidc_provider, oidc_sub) with non-null WHERE', async () => {
    await runMigrations(db);

    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_users_oidc_sub_provider'",
      )
      .get() as { sql: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.sql).toBeTruthy();
    expect(row?.sql).toContain('WHERE');
    expect(row?.sql).toContain('oidc_provider IS NOT NULL');
    expect(row?.sql).toContain('oidc_sub IS NOT NULL');
  });

  it('creates partial unique index on slack_user_id with non-null WHERE', async () => {
    await runMigrations(db);

    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_users_slack_user_id'",
      )
      .get() as { sql: string | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.sql).toBeTruthy();
    expect(row?.sql).toContain('WHERE');
    expect(row?.sql).toContain('slack_user_id IS NOT NULL');
  });

  it('creates unique index on api_tokens.hash and non-unique index on api_tokens.user_id', async () => {
    await runMigrations(db);

    const indexList = db.prepare("PRAGMA index_list('api_tokens')").all() as Array<{
      name: string;
      unique: number;
    }>;
    const byName: Record<string, { unique: number }> = {};
    for (const idx of indexList) byName[idx.name] = { unique: idx.unique };

    expect(byName['idx_api_tokens_hash']).toBeDefined();
    expect(byName['idx_api_tokens_hash'].unique).toBe(1);

    expect(byName['idx_api_tokens_user_id']).toBeDefined();
    expect(byName['idx_api_tokens_user_id'].unique).toBe(0);
  });

  it('partial unique index permits multiple (NULL, NULL) rows', async () => {
    await runMigrations(db);

    // Two legacy users with no OIDC binding should both insert.
    db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('legacy-one');
    db.prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`).run('legacy-two');

    const count = db.prepare('SELECT COUNT(*) AS c FROM users').get() as {
      c: number;
    };
    expect(count.c).toBe(2);
  });

  it('partial unique index rejects duplicate (provider, sub) pairs', async () => {
    await runMigrations(db);

    db.prepare(
      `INSERT INTO users (display_name, oidc_provider, oidc_sub)
       VALUES (?, ?, ?)`,
    ).run('first', 'google', 'abc');

    expect(() =>
      db
        .prepare(
          `INSERT INTO users (display_name, oidc_provider, oidc_sub)
           VALUES (?, ?, ?)`,
        )
        .run('second', 'google', 'abc'),
    ).toThrow();
  });

  it('api_tokens.user_id FK ON DELETE CASCADE removes tokens when user is deleted', async () => {
    await runMigrations(db);

    const userRes = db
      .prepare(`INSERT INTO users (display_name, is_legacy) VALUES (?, 1)`)
      .run('cascade-target');
    const userId = userRes.lastInsertRowid as number;

    db.prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(userId, 'token-1', 'wft_pat_', 'AAAA', 'hash-aaaa');

    db.prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(userId, 'token-2', 'wft_pat_', 'BBBB', 'hash-bbbb');

    const before = db
      .prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?')
      .get(userId) as { c: number };
    expect(before.c).toBe(2);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    const after = db
      .prepare('SELECT COUNT(*) AS c FROM api_tokens WHERE user_id = ?')
      .get(userId) as { c: number };
    expect(after.c).toBe(0);
  });

  // The set of objects migration 008 itself owns. Used by the round-trip
  // tests below — scoped narrowly so additive later migrations (e.g. 010's
  // idx_users_legacy_display_name / idx_users_slack_bot) do not get pulled
  // into the 008-isolated round-trip and cause a false negative.
  const MIGRATION_008_OBJECTS = [
    'users',
    'api_tokens',
    'idx_users_oidc_sub_provider',
    'idx_users_slack_user_id',
    'idx_api_tokens_hash',
    'idx_api_tokens_user_id',
  ];

  it('down() drops users, api_tokens, and all identity indexes', async () => {
    await runMigrations(db);

    const { down } = await import('../migrations/008-identity-tables.js');
    await down(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','api_tokens')",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(0);

    // Only the four indexes that migration 008 itself creates. Later
    // migrations may add additional idx_users_* indexes (e.g. migration
    // 010); those are dropped transitively when DROP TABLE users runs,
    // but it would be a category error to assert "all indexes named like
    // a migration-008 name are gone" — we check exactly the 008 set.
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name IN (
           'idx_users_oidc_sub_provider',
           'idx_users_slack_user_id',
           'idx_api_tokens_hash',
           'idx_api_tokens_user_id'
         )`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes).toHaveLength(0);
  });

  it('up() after down() restores schema (round-trip)', async () => {
    await runMigrations(db);

    // Capture exactly the objects migration 008 owns. Scoping by an IN-list
    // (instead of a LIKE pattern) keeps later additive migrations from
    // bleeding into this round-trip — see MIGRATION_008_OBJECTS comment.
    const placeholders = MIGRATION_008_OBJECTS.map(() => '?').join(',');
    const snapshotStmt = db.prepare(
      `SELECT name, type, sql FROM sqlite_master WHERE name IN (${placeholders}) ORDER BY type, name`,
    );

    const before = snapshotStmt.all(...MIGRATION_008_OBJECTS);

    const { up, down } = await import('../migrations/008-identity-tables.js');
    await down(db);
    await up(db);

    const after = snapshotStmt.all(...MIGRATION_008_OBJECTS);

    expect(after).toEqual(before);
  });
});
