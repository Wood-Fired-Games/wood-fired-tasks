import Database from './driver.js';
import { mkdir } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { initDatabase } from './database.js';
import { isMain } from '../utils/is-main.js';
import { resolveDbPath } from '../config/db-path.js';

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
 * The shape every module under `migrations/` exports. `down` is used by the
 * round-trip tests (which import the modules directly); the runner only ever
 * applies `up`.
 */
interface MigrationModule {
  up(db: Database.Database): unknown;
  down?(db: Database.Database): unknown;
}

/** A migration file discovered on disk. */
interface MigrationFile {
  /** Canonical (extensionless) name — the `_migrations.name` primary key. */
  name: string;
  /** Absolute filesystem path of the module. */
  path: string;
}

/**
 * Overrides for where migrations are discovered. Production callers never pass
 * these; tests use them to point the runner at a fixture directory.
 */
export interface MigrationOptions {
  /** Directory holding the `NNN-<slug>.<ext>` migration modules. */
  migrationsDir?: string;
  /** Module extension to discover (`ts` under tsx, `js` from dist/). */
  extension?: 'ts' | 'js';
}

/**
 * Default discovery location: `<this dir>/migrations/*.<ext>`.
 *
 * Supports both .ts (dev/test via tsx) and .js (production compiled)
 * migrations. Normalize separators first: on Windows __dirname uses
 * backslashes, so a literal `/dist/` substring check silently fails and we'd
 * look for .ts migrations that don't ship in the compiled package
 * (→ "no such table").
 */
function defaultDiscovery(): { migrationsDir: string; extension: 'ts' | 'js' } {
  const dirPosix = __dirname.split(sep).join('/');
  return {
    migrationsDir: join(__dirname, 'migrations'),
    extension: dirPosix.includes('/dist/') ? 'js' : 'ts',
  };
}

/**
 * List migration files in apply order.
 *
 * Only `NNN-<slug>.<ext>` files match: the slug may not contain a dot, which
 * excludes the `.d.ts` / `.js.map` / `.d.ts.map` siblings tsc emits into
 * dist/db/migrations. Names are zero-padded, so a lexicographic sort is the
 * intended numeric apply order.
 */
function discoverMigrations(options: MigrationOptions = {}): MigrationFile[] {
  const defaults = defaultDiscovery();
  const dir = options.migrationsDir ?? defaults.migrationsDir;
  const ext = options.extension ?? defaults.extension;
  const pattern = new RegExp(`^\\d{3}-[^.]+\\.${ext}$`);
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => ({ name: canonicalName(f), path: join(dir, f) }));
}

/**
 * Create the `_migrations` tracking table if needed and canonicalize legacy rows.
 *
 * Migration names are stored and compared WITHOUT file extensions so that
 * .ts (dev/test via tsx) and .js (production via dist/) are treated as the
 * same migration. The schema is byte-identical to the one the
 * previous third-party-runner storage (SQLiteStorage) created, so existing
 * databases are read as-is.
 */
function prepareTrackingTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // One-time fixup: rename any legacy entries that have .ts/.js extensions to
  // their canonical (extensionless) form. Idempotent — if entries are already
  // canonical, no UPDATE runs.
  const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  const update = db.prepare('UPDATE _migrations SET name = ? WHERE name = ?');
  for (const row of rows) {
    const canonical = canonicalName(row.name);
    if (canonical !== row.name) {
      update.run(canonical, row.name);
    }
  }
}

/** Canonical names of every migration recorded in `_migrations`. */
function executedMigrations(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations ORDER BY name').all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Names of migrations on disk that are not yet recorded, in apply order.
 * Ensures the tracking table exists (and canonicalizes legacy rows) first.
 */
export function pendingMigrations(db: Database.Database, options: MigrationOptions = {}): string[] {
  prepareTrackingTable(db);
  const executed = executedMigrations(db);
  return discoverMigrations(options)
    .filter((m) => !executed.has(m.name))
    .map((m) => m.name);
}

/**
 * Run all pending migrations.
 *
 * Uses BEGIN EXCLUSIVE to serialize concurrent migration runs — only one process
 * at a time can discover-and-apply pending migrations. If a second process starts
 * while the first holds the exclusive lock, it waits (up to busy_timeout) then
 * discovers no pending migrations and returns immediately.
 *
 * All pending migrations apply inside that single transaction: if any `up()`
 * throws, the whole run is rolled back — neither the failing migration nor any
 * migration applied earlier in the same run is recorded, and their schema
 * changes are undone. Migrations committed by previous runs are untouched.
 */
export async function runMigrations(
  db: Database.Database,
  options: MigrationOptions = {},
): Promise<void> {
  db.exec('BEGIN EXCLUSIVE');
  try {
    prepareTrackingTable(db);
    const executed = executedMigrations(db);
    const record = db.prepare('INSERT INTO _migrations (name) VALUES (?)');
    for (const migration of discoverMigrations(options)) {
      if (executed.has(migration.name)) continue;
      console.error('[migration]', { event: 'migrating', name: migration.name });
      const started = performance.now();
      // Dynamic import needs a file:// URL: on Windows an absolute path like
      // C:\...\001.js makes ESM treat `C:` as an unsupported URL scheme
      // (ERR_UNSUPPORTED_ESM_URL_SCHEME). pathToFileURL is a no-op-equivalent
      // on POSIX and the correct encoding everywhere.
      const mod = (await import(
        /* @vite-ignore */ pathToFileURL(migration.path).href
      )) as MigrationModule;
      await mod.up(db);
      record.run(migration.name);
      const durationSeconds = (performance.now() - started) / 1000;
      console.error('[migration]', { event: 'migrated', name: migration.name, durationSeconds });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Resolve the database path the migration CLI should target.
 *
 * Delegates to the unified resolver (`src/config/db-path.ts`) so the migration
 * CLI converges on the EXACT same path as the API server, MCP stdio server,
 * and every `tasks db*` subcommand. The unified precedence is:
 *   env (DATABASE_PATH / deprecated DB_PATH) > legacy-adopt ./data/tasks.db
 *   (when present and the app-data DB is absent, with a one-time warning) >
 *   OS app-data default.
 * The resolved value is then forced absolute against `cwd` so the migration
 * CLI's returned path is stable regardless of later chdir's.
 *
 * @param env - environment map (defaults to `process.env`).
 * @param cwd - base directory for resolving relative paths and probing the
 *   legacy `./data/tasks.db` (defaults to `process.cwd()`).
 * @param exists - filesystem existence probe forwarded to the unified resolver
 *   (defaults to `fs.existsSync`). Injectable so tests can isolate the
 *   legacy-adopt vs app-data branches without depending on whether the real OS
 *   app-data DB happens to exist on the dev machine running the suite.
 */
export function resolveMigrateDbPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string {
  return resolve(cwd, resolveDbPath(env, cwd, exists));
}

/**
 * CLI entry point body: resolve the target DB path via the unified resolver
 * (env > legacy-adopt > app-data default), ensure the parent
 * directory exists, then run all pending migrations.
 *
 * Extracted from the `isMain` guard so it is directly unit-testable.
 */
export async function migrateCli(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): Promise<string> {
  const dbPath = resolveMigrateDbPath(env, cwd, exists);

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
