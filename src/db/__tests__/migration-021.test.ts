import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_021 = '021-project-archive.ts';
const ARCHIVE_COLUMNS = ['archive_reason', 'archived_at', 'archived_by'];

interface MigrationModule {
  up: (db: Database.Database) => void | Promise<void>;
  down: (db: Database.Database) => void | Promise<void>;
}

interface ColumnDef {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

async function loadMigration(filename: string): Promise<MigrationModule> {
  const url = pathToFileURL(join(MIGRATIONS_DIR, filename)).href;
  return (await import(/* @vite-ignore */ url)) as MigrationModule;
}

/** Sorted full column definitions: order-insensitive, drift-sensitive. */
function projectColumnDefs(db: Database.Database): ColumnDef[] {
  return (db.prepare("PRAGMA table_info('projects')").all() as ColumnDef[])
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Integration tests for migration 021: the archive columns on `projects`
 * (docs/design/project-archived-state.md §3.1).
 *
 * The data-preservation cases build a genuine pre-021 database by calling
 * up() for every migration before 021 directly, seed a fully populated
 * project row, and only then apply 021 — the shape of an upgrade on a live
 * database.
 */
describe('migration 021: projects archive columns', () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  describe('on a seeded pre-021 database', () => {
    let migration: MigrationModule;
    let seeded: Record<string, unknown>;
    let pre021Columns: ColumnDef[];

    beforeEach(async () => {
      db = initTestDatabase();
      const earlier = readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d{3}-[^.]+\.ts$/.test(f) && f < MIGRATION_021)
        .sort();
      expect(earlier.at(-1)).toBe('020-api-token-project-scope.ts');
      for (const file of earlier) {
        await (await loadMigration(file)).up(db);
      }

      pre021Columns = projectColumnDefs(db);
      for (const column of ARCHIVE_COLUMNS) {
        expect(pre021Columns.map((c) => c.name)).not.toContain(column);
      }

      db.prepare(
        `INSERT INTO projects (name, description, value_charter, model_policy, scm)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'pre-021 project',
        'seeded before the archive columns existed',
        JSON.stringify({ mission: 'ship' }),
        JSON.stringify({ default: 'sonnet' }),
        JSON.stringify({ backend: 'git' }),
      );
      seeded = db.prepare('SELECT * FROM projects WHERE name = ?').get('pre-021 project') as Record<
        string,
        unknown
      >;

      migration = await loadMigration(MIGRATION_021);
    });

    it('up() leaves the existing row intact with the three columns NULL', async () => {
      await migration.up(db);

      const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(seeded.id) as Record<
        string,
        unknown
      >;
      expect(after).toEqual({
        ...seeded,
        archived_at: null,
        archived_by: null,
        archive_reason: null,
      });
      expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get()).toEqual({ c: 1 });
    });

    it('up() adds archived_at, archived_by and archive_reason as nullable TEXT with no default', async () => {
      await migration.up(db);

      const defs = projectColumnDefs(db);
      for (const column of ARCHIVE_COLUMNS) {
        const def = defs.find((c) => c.name === column);
        expect(def, `${column} must exist`).toBeDefined();
        expect(def?.type).toBe('TEXT');
        expect(def?.notnull).toBe(0);
        expect(def?.dflt_value).toBeNull();
        expect(def?.pk).toBe(0);
      }
      expect(defs).toHaveLength(pre021Columns.length + 3);
    });

    it('the columns round-trip populated values', async () => {
      await migration.up(db);

      db.prepare(
        'UPDATE projects SET archived_at = ?, archived_by = ?, archive_reason = ? WHERE id = ?',
      ).run('2026-11-23T12:00:00.000Z', 'alice', 'shipped', seeded.id);

      const row = db
        .prepare('SELECT archived_at, archived_by, archive_reason FROM projects WHERE id = ?')
        .get(seeded.id);
      expect(row).toEqual({
        archived_at: '2026-11-23T12:00:00.000Z',
        archived_by: 'alice',
        archive_reason: 'shipped',
      });
    });

    it('down() restores the prior column set and keeps the row', async () => {
      await migration.up(db);
      db.prepare('UPDATE projects SET archived_at = ?, archived_by = ? WHERE id = ?').run(
        '2026-11-23T12:00:00.000Z',
        'alice',
        seeded.id,
      );

      await migration.down(db);

      expect(projectColumnDefs(db)).toEqual(pre021Columns);
      expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(seeded.id)).toEqual(seeded);
    });

    it('up() after down() restores the archive columns (round-trip)', async () => {
      await migration.up(db);
      const withArchive = projectColumnDefs(db);

      await migration.down(db);
      await migration.up(db);

      expect(projectColumnDefs(db)).toEqual(withArchive);
    });
  });

  describe('through the migration runner', () => {
    beforeEach(async () => {
      db = initTestDatabase();
      await runMigrations(db);
    });

    it('the runner applies 021 and a new project reads the columns as NULL', () => {
      const applied = db
        .prepare("SELECT name FROM _migrations WHERE name LIKE '021-%'")
        .all() as Array<{ name: string }>;
      expect(applied).toHaveLength(1);

      const id = db.prepare('INSERT INTO projects (name) VALUES (?)').run('p').lastInsertRowid;
      const row = db
        .prepare('SELECT archived_at, archived_by, archive_reason FROM projects WHERE id = ?')
        .get(id);
      expect(row).toEqual({ archived_at: null, archived_by: null, archive_reason: null });
    });
  });
});
