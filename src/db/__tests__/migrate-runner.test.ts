import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { initTestDatabase } from '../database.js';
import { pendingMigrations, runMigrations } from '../migrate.js';
import type Database from '../driver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Behavioural contract of the in-house migration runner in src/db/migrate.ts
 * (task #2130 — replaced the third-party runner):
 *   - a DB whose `_migrations` table was written by the legacy third-party-runner-backed
 *     SQLiteStorage is read as fully migrated (zero pending, no-op run);
 *   - a fresh DB gets every migration applied in filename order, exactly once;
 *   - a throwing migration rolls the whole run back and is not recorded.
 */

/** Current migration files, in apply order (zero-padded → lexicographic). */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-[^.]+\.ts$/.test(f))
    .sort();
}

function canonical(file: string): string {
  return file.replace(/\.[tj]s$/, '');
}

function schemaSnapshot(db: Database.Database): unknown[] {
  return db
    .prepare(
      `SELECT name, type, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();
}

function trackingRows(db: Database.Database): Array<{ name: string; executed_at: string }> {
  return db.prepare('SELECT name, executed_at FROM _migrations ORDER BY name').all() as Array<{
    name: string;
    executed_at: string;
  }>;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

/** Messages the runner logged for a given event, in emission order. */
function loggedNames(spy: ReturnType<typeof vi.spyOn>, event: string): string[] {
  return spy.mock.calls
    .filter((args: unknown[]) => args[0] === '[migration]')
    .map((args: unknown[]) => args[1] as { event: string; name: string })
    .filter((msg) => msg.event === event)
    .map((msg) => msg.name);
}

/**
 * Build a DB exactly as the legacy third-party runner left it: every migration's up()
 * applied, plus the `_migrations` table with the DDL SQLiteStorage created and
 * one row per migration inserted the way SQLiteStorage.logMigration did
 * (`INSERT INTO _migrations (name) VALUES (?)` with the canonical name, or —
 * for pre-canonicalization DBs — the raw filename including its extension).
 */
async function seedUmzugEraDb(withExtensions: boolean): Promise<Database.Database> {
  const db = initTestDatabase();
  for (const file of migrationFiles()) {
    const mod = (await import(
      /* @vite-ignore */ pathToFileURL(join(MIGRATIONS_DIR, file)).href
    )) as {
      up: (d: Database.Database) => unknown;
    };
    await mod.up(db);
  }
  db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        executed_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  const insert = db.prepare('INSERT INTO _migrations (name) VALUES (?)');
  for (const file of migrationFiles()) {
    insert.run(withExtensions ? file : canonical(file));
  }
  return db;
}

describe('migration runner', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('sanity: there are migrations to test against', () => {
    expect(migrationFiles().length).toBeGreaterThanOrEqual(20);
  });

  describe('DB migrated by the legacy SQLiteStorage', () => {
    it('reports zero pending and runMigrations is a no-op', async () => {
      const db = await seedUmzugEraDb(false);
      const schemaBefore = schemaSnapshot(db);
      const rowsBefore = trackingRows(db);

      expect(pendingMigrations(db)).toEqual([]);
      await runMigrations(db);

      expect(schemaSnapshot(db)).toEqual(schemaBefore);
      expect(trackingRows(db)).toEqual(rowsBefore);
      expect(rowsBefore.map((r) => r.name)).toEqual(migrationFiles().map(canonical));
      expect(loggedNames(logSpy, 'migrating')).toEqual([]);
      db.close();
    });

    it('canonicalizes legacy extension-bearing rows and still applies nothing', async () => {
      const db = await seedUmzugEraDb(true);
      const schemaBefore = schemaSnapshot(db);

      expect(pendingMigrations(db)).toEqual([]);
      await runMigrations(db);

      expect(schemaSnapshot(db)).toEqual(schemaBefore);
      expect(trackingRows(db).map((r) => r.name)).toEqual(migrationFiles().map(canonical));
      expect(loggedNames(logSpy, 'migrating')).toEqual([]);
      db.close();
    });
  });

  describe('fresh DB', () => {
    it('applies every migration in name order, records each once, and a second run is a no-op', async () => {
      const db = initTestDatabase();
      const expected = migrationFiles().map(canonical);

      expect(pendingMigrations(db)).toEqual(expected);
      await runMigrations(db);

      expect(loggedNames(logSpy, 'migrating')).toEqual(expected);
      expect(loggedNames(logSpy, 'migrated')).toEqual(expected);
      expect(trackingRows(db).map((r) => r.name)).toEqual(expected);
      expect(pendingMigrations(db)).toEqual([]);

      const schemaAfterFirst = schemaSnapshot(db);
      const rowsAfterFirst = trackingRows(db);
      logSpy.mockClear();

      await runMigrations(db);

      expect(loggedNames(logSpy, 'migrating')).toEqual([]);
      expect(schemaSnapshot(db)).toEqual(schemaAfterFirst);
      expect(trackingRows(db)).toEqual(rowsAfterFirst);
      db.close();
    });
  });

  describe('failing migration', () => {
    let fixtureDir: string;

    beforeEach(() => {
      fixtureDir = mkdtempSync(join(tmpdir(), 'wft-migrate-runner-'));
      writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module' }));
    });

    afterEach(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    function writeMigration(file: string, body: string): void {
      writeFileSync(join(fixtureDir, file), body);
    }

    it('rejects, rolls back the run, and leaves no row for the failing migration', async () => {
      const opts = { migrationsDir: fixtureDir, extension: 'js' as const };
      writeMigration(
        '001-first.js',
        "export function up(db) { db.exec('CREATE TABLE first_t (id INTEGER)'); }\n",
      );
      const db = initTestDatabase();
      await runMigrations(db, opts);
      expect(trackingRows(db).map((r) => r.name)).toEqual(['001-first']);

      writeMigration(
        '002-second.js',
        "export function up(db) { db.exec('CREATE TABLE second_t (id INTEGER)'); }\n",
      );
      writeMigration(
        '003-broken.js',
        "export function up(db) { db.exec('CREATE TABLE broken_t (id INTEGER)'); throw new Error('boom-003'); }\n",
      );

      await expect(runMigrations(db, opts)).rejects.toThrow('boom-003');

      // The failing migration is not recorded and its partial DDL is undone.
      // Because the whole run shares one EXCLUSIVE transaction, 002 (applied
      // earlier in the same run) is rolled back too; 001 (committed by the
      // previous run) is untouched.
      expect(trackingRows(db).map((r) => r.name)).toEqual(['001-first']);
      expect(tableExists(db, 'first_t')).toBe(true);
      expect(tableExists(db, 'second_t')).toBe(false);
      expect(tableExists(db, 'broken_t')).toBe(false);
      expect(pendingMigrations(db, opts)).toEqual(['002-second', '003-broken']);
      expect(db.inTransaction).toBe(false);
      db.close();
    });

    it('ignores non-migration siblings such as .d.ts and .map files', async () => {
      const opts = { migrationsDir: fixtureDir, extension: 'js' as const };
      writeMigration('001-only.js', 'export function up() {}\n');
      writeMigration('001-only.js.map', '{}');
      writeMigration('001-only.d.ts', 'export {};\n');
      writeMigration('notes.js', "throw new Error('must not be imported');\n");

      const db = initTestDatabase();
      expect(pendingMigrations(db, opts)).toEqual(['001-only']);
      expect(pendingMigrations(db, { migrationsDir: fixtureDir, extension: 'ts' })).toEqual([]);
      db.close();
    });
  });
});
