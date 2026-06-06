import type Database from '../driver.js';

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Add version column for optimistic locking (CAS pattern)
    db.exec(`
      ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    `);

    // Add claimed_at timestamp for auto-release tracking
    db.exec(`
      ALTER TABLE tasks ADD COLUMN claimed_at TEXT
    `);

    // Create idempotency_keys table for claim deduplication
    db.exec(`
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Index for TTL cleanup of expired idempotency keys
    db.exec(`
      CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys(created_at)
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    // Drop idempotency_keys table
    db.exec(`
      DROP TABLE IF EXISTS idempotency_keys
    `);

    // Drop claimed_at column
    db.exec(`
      ALTER TABLE tasks DROP COLUMN claimed_at
    `);

    // Drop version column
    db.exec(`
      ALTER TABLE tasks DROP COLUMN version
    `);
  })();
}
