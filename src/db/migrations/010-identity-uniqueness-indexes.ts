import type Database from '../driver.js';

/**
 * Migration 010: partial UNIQUE indexes backing the boot-time seeder's
 * idempotency.
 *
 * Background (WR-04 of 27-REVIEW.md): the Phase-27 boot-time seeder in
 * `src/services/identity-seeder.ts` enforced uniqueness for the two seeded
 * row classes (legacy users by `display_name`, the slack-bot service-account
 * row) via application-level `INSERT ... WHERE NOT EXISTS (...)`. That check
 * has no backing DB-level UNIQUE constraint, so two concurrent boots against
 * a shared DB file could both pass their respective WHERE-NOT-EXISTS
 * subqueries and both INSERT — producing duplicate rows that downstream
 * lookups would have no way to disambiguate.
 *
 * Migration 008 is already committed and merged, so its CREATE TABLE cannot
 * be amended retroactively. Adding the constraints in a follow-up migration
 * is the additive fix: existing data is unaffected (no duplicates exist
 * today because the seeder only runs at single-process boot), and Phase 28+
 * gets the DB-level guard from this point forward.
 *
 * Two partial unique indexes:
 *
 *   1. idx_users_legacy_display_name — UNIQUE(display_name) WHERE is_legacy = 1
 *      Enforces: at most one legacy row per display_name. Non-legacy rows
 *      with the same display_name (OIDC or service-account) remain free.
 *
 *   2. idx_users_slack_bot — UNIQUE(display_name) WHERE is_service_account = 1
 *      Enforces: at most one service-account row per display_name. Today the
 *      seeder only creates a single 'slack-bot' service-account row, so this
 *      effectively means "exactly one slack-bot". If future service-account
 *      kinds are introduced they will need distinct display_names — that's
 *      the intended design.
 *
 * Both indexes use CREATE UNIQUE INDEX IF NOT EXISTS for the
 * partial-replay-safety pattern established by migration 008.
 *
 * Seeder cooperation: with these indexes in place, the seeder's INSERTs
 * switch from `INSERT ... WHERE NOT EXISTS` to
 * `INSERT ... ON CONFLICT DO NOTHING`, so a concurrent-boot race becomes a
 * no-op (the second INSERT bumps info.changes to 0 and the seeder records
 * it as `alreadyPresent`) instead of a duplicate row.
 *
 * Note: the database calls below use the better-sqlite3 Database method
 * (executes SQL on the connection). No shell involved.
 */
export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_legacy_display_name
        ON users(display_name)
        WHERE is_legacy = 1
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack_bot
        ON users(display_name)
        WHERE is_service_account = 1
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`DROP INDEX IF EXISTS idx_users_slack_bot`);
    db.exec(`DROP INDEX IF EXISTS idx_users_legacy_display_name`);
  })();
}
