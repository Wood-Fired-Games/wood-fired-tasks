import type Database from 'better-sqlite3';

/**
 * Migration 008: identity tables (users, api_tokens).
 *
 * Adds the foundational identity schema locked in REQUIREMENTS.md
 * (IDENT-01, IDENT-02). Purely additive -- no existing tables are touched.
 *
 * Notes:
 * - First use of partial unique indexes in this codebase
 *   (better-sqlite3 12.x bundles SQLite 3.46+; partial indexes supported).
 *   idx_users_oidc_sub_provider is unique only when both columns are
 *   non-null, which permits multiple legacy users with (NULL, NULL).
 * - IF NOT EXISTS is used on indexes for idempotent partial-replay safety;
 *   Umzug's _migrations table prevents re-running normally, but this is
 *   harmless belt-and-braces and matches the convention in CONTEXT.md.
 * - down() drops indexes before tables (DROP TABLE would clean them up,
 *   but explicit drops match the migration-007 convention and keep the
 *   migrations-roundtrip schema-snapshot test deterministic).
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        oidc_sub TEXT,
        oidc_provider TEXT,
        email TEXT,
        display_name TEXT NOT NULL,
        slack_user_id TEXT,
        is_legacy INTEGER NOT NULL DEFAULT 0,
        is_service_account INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        disabled_at TEXT
      )
    `);

    db.exec(`
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        suffix TEXT NOT NULL,
        hash TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT,
        expires_at TEXT
      )
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_sub_provider
        ON users(oidc_provider, oidc_sub)
        WHERE oidc_provider IS NOT NULL AND oidc_sub IS NOT NULL
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack_user_id
        ON users(slack_user_id)
        WHERE slack_user_id IS NOT NULL
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_hash
        ON api_tokens(hash)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id
        ON api_tokens(user_id)
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Drop indexes first (defensive). DROP TABLE removes them anyway, but
    // explicit drops match the migration-007 convention and keep the
    // migrations-roundtrip schema-snapshot test deterministic.
    db.exec(`DROP INDEX IF EXISTS idx_api_tokens_user_id`);
    db.exec(`DROP INDEX IF EXISTS idx_api_tokens_hash`);
    db.exec(`DROP INDEX IF EXISTS idx_users_slack_user_id`);
    db.exec(`DROP INDEX IF EXISTS idx_users_oidc_sub_provider`);

    // Drop api_tokens before users (FK reference points api_tokens -> users).
    db.exec(`DROP TABLE IF EXISTS api_tokens`);
    db.exec(`DROP TABLE IF EXISTS users`);
  })();
}
