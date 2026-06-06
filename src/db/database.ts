import Database from './driver.js';

/**
 * Initialize a SQLite database with proper configuration.
 * Sets WAL mode, foreign keys, and busy timeout for concurrent access.
 */
export function initDatabase(filepath: string): Database.Database {
  const db = new Database(filepath);

  // Set WAL mode for better concurrent access (file-based only, ignored for :memory:)
  db.pragma('journal_mode = WAL');

  // Enable foreign key constraints
  db.pragma('foreign_keys = ON');

  // Set synchronous mode to NORMAL for better performance with WAL
  db.pragma('synchronous = NORMAL');

  // Set busy timeout to 5 seconds for handling concurrent access
  db.pragma('busy_timeout = 5000');

  return db;
}

/**
 * Initialize an in-memory database for testing.
 * Sets foreign keys but skips WAL mode (not applicable for in-memory).
 */
export function initTestDatabase(): Database.Database {
  return initDatabase(':memory:');
}
