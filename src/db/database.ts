import Database from './driver.js';
import { chmodSync, existsSync } from 'node:fs';

const POSIX = process.platform !== 'win32';

/**
 * Best-effort permission tightening to 0o600 (owner read/write only).
 *
 * Swallows any error (missing file, EACCES, unsupported filesystem, a
 * TOCTOU race with an external delete) — this is a defense-in-depth
 * hardening step, not a correctness requirement, and must never take down
 * database initialization for callers on an unusual path. POSIX-only:
 * chmod mode bits don't map cleanly to Windows ACLs.
 */
function tightenPermissions(path: string): void {
  if (!POSIX) return;
  try {
    if (existsSync(path)) {
      chmodSync(path, 0o600);
    }
  } catch {
    // Best-effort only — see doc comment above.
  }
}

/**
 * Initialize a SQLite database with proper configuration.
 * Sets WAL mode, foreign keys, and busy timeout for concurrent access.
 *
 * For file-backed databases (anything other than ':memory:'), the database
 * file holds token hashes, user emails, verification evidence, and webhook
 * configuration — so it is chmod'd to 0o600 immediately after open rather
 * than left at the ambient umask (audit finding M4). The -wal and -shm
 * sidecars are tightened too, once WAL mode is set — they don't exist
 * before that point, and in the common case (a brand-new database) they
 * won't exist yet even after the pragma; SQLite creates them lazily on the
 * first write, inheriting the main file's mode, which is why chmod'ing the
 * main file first is what actually matters. The explicit sidecar chmods
 * below exist to cover the case of reopening a pre-existing database whose
 * sidecars already exist with loose permissions.
 */
export function initDatabase(filepath: string): Database.Database {
  const db = new Database(filepath);
  const isFileBacked = filepath !== ':memory:';

  if (isFileBacked) {
    tightenPermissions(filepath);
  }

  // Set WAL mode for better concurrent access (file-based only, ignored for :memory:)
  db.pragma('journal_mode = WAL');

  if (isFileBacked) {
    tightenPermissions(`${filepath}-wal`);
    tightenPermissions(`${filepath}-shm`);
  }

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
