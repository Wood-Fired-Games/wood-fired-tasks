import Database from './driver.js';
import { Umzug, type UmzugStorage } from 'umzug';
import { mkdir } from 'fs/promises';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './database.js';
import { isMain } from '../utils/is-main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Normalize a migration name to a canonical form without file extension.
 * This ensures migrations recorded as .ts (dev via tsx) are recognized
 * when running from compiled .js (dist/), and vice versa.
 */
function canonicalName(name: string): string {
  return name.replace(/\.[tj]s$/, '');
}

/**
 * Custom Umzug storage that uses SQLite to track migrations.
 *
 * Migration names are stored and compared WITHOUT file extensions so that
 * .ts (dev/test via tsx) and .js (production via dist/) are treated as
 * the same migration. This prevents re-running migrations when switching
 * between dev and compiled execution modes.
 */
class SQLiteStorage implements UmzugStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureMigrationsTable();
    this.normalizeExistingEntries();
  }

  private ensureMigrationsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        executed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * One-time fixup: rename any legacy entries that have .ts/.js extensions
   * to their canonical (extensionless) form. This is idempotent — if entries
   * are already canonical, the UPDATE matches zero rows.
   */
  private normalizeExistingEntries() {
    const rows = this.db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
    const update = this.db.prepare('UPDATE _migrations SET name = ? WHERE name = ?');
    for (const row of rows) {
      const canonical = canonicalName(row.name);
      if (canonical !== row.name) {
        update.run(canonical, row.name);
      }
    }
  }

  async logMigration({ name }: { name: string }): Promise<void> {
    this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(canonicalName(name));
  }

  async unlogMigration({ name }: { name: string }): Promise<void> {
    this.db.prepare('DELETE FROM _migrations WHERE name = ?').run(canonicalName(name));
  }

  async executed(): Promise<string[]> {
    const rows = this.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
    return rows.map(row => row.name);
  }
}

/**
 * Create an Umzug instance configured for this project.
 */
function createUmzug(db: Database.Database): Umzug<Database.Database> {
  // Support both .ts (dev/test via tsx) and .js (production compiled) migrations.
  // Normalize separators first: on Windows __dirname uses backslashes, so a
  // literal `/dist/` substring check silently fails and we'd glob for .ts
  // migrations that don't ship in the compiled package (→ "no such table").
  const dirPosix = __dirname.split(sep).join('/');
  const ext = dirPosix.includes('/dist/') ? 'js' : 'ts';

  return new Umzug({
    migrations: {
      // fast-glob (Umzug's matcher) requires forward slashes even on Windows;
      // `join` would emit backslashes, matching nothing. Build the glob with
      // the POSIX-normalized dir.
      glob: `${dirPosix}/migrations/*.${ext}`,
      resolve: ({ name, path }) => ({
        // Use canonical (extensionless) name so .ts and .js are treated identically
        name: canonicalName(name),
        up: async () => {
          const migration = await import(path!);
          return migration.up(db);
        },
        down: async () => {
          const migration = await import(path!);
          return migration.down(db);
        },
      }),
    },
    context: db,
    storage: new SQLiteStorage(db),
    logger: {
      info: (msg: Record<string, unknown>) => console.error('[migration]', msg),
      warn: (msg: Record<string, unknown>) => console.error('[migration:warn]', msg),
      error: (msg: Record<string, unknown>) => console.error('[migration:error]', msg),
      debug: (msg: Record<string, unknown>) => console.error('[migration:debug]', msg),
    },
  });
}

/**
 * Run all pending migrations.
 *
 * Uses BEGIN EXCLUSIVE to serialize concurrent migration runs — only one process
 * at a time can discover-and-apply pending migrations. If a second process starts
 * while the first holds the exclusive lock, it waits (up to busy_timeout) then
 * runs umzug.up() itself, which finds no pending migrations and returns immediately.
 */
export async function runMigrations(db: Database.Database): Promise<void> {
  db.exec('BEGIN EXCLUSIVE');
  try {
    const umzug = createUmzug(db);
    await umzug.up();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Resolve the database path the migration CLI should target.
 *
 * Honors `DATABASE_PATH` (the same env var the API/CLI validate via
 * src/config/env.ts, which carries the documented `./data/tasks.db`
 * default) and falls back to `./data/tasks.db` when it is unset or empty.
 * Relative paths are resolved against `cwd` so the returned value is
 * absolute and stable regardless of where the process later chdir's.
 *
 * @param env - environment map (defaults to `process.env`).
 * @param cwd - base directory for resolving relative paths (defaults to
 *   `process.cwd()`).
 */
export function resolveMigrateDbPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const raw = env.DATABASE_PATH && env.DATABASE_PATH.length > 0
    ? env.DATABASE_PATH
    : './data/tasks.db';
  return resolve(cwd, raw);
}

/**
 * CLI entry point body: resolve the target DB path from `DATABASE_PATH`
 * (or the documented `./data/tasks.db` fallback), ensure the parent
 * directory exists, then run all pending migrations.
 *
 * Extracted from the `isMain` guard so it is directly unit-testable.
 */
export async function migrateCli(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const dbPath = resolveMigrateDbPath(env, cwd);

  // Create the parent directory (e.g. ./data, or a user-supplied path) if
  // it doesn't already exist. `recursive: true` is a no-op when present.
  await mkdir(dirname(dbPath), { recursive: true });

  const db = initDatabase(dbPath);
  try {
    await runMigrations(db);
  } finally {
    db.close();
  }
  return dbPath;
}

/**
 * CLI entry point: run migrations against the DATABASE_PATH-resolved DB.
 */
if (isMain(import.meta.url)) {
  const dbPath = await migrateCli();
  console.log(`Migrations complete! (${dbPath})`);
}
