import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { initTestDatabase } from '../database.js';
import type Database from '../driver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Up -> Down -> Up round-trip tests with schema snapshot.
 *
 * For each migration `i` in src/db/migrations/:
 *   1. Run up() for all migrations 001..i on a fresh in-memory DB.
 *   2. Snapshot schema (sqlite_master rows) AND row counts of all user tables.
 *   3. Run i.down() then i.up().
 *   4. Assert post-roundtrip state EQUALS the pre-roundtrip snapshot exactly.
 *   5. Commit the snapshot to the repo via vitest's toMatchSnapshot so any
 *      future drift in a migration's net effect surfaces in PR diffs.
 *
 * Why this matters:
 * - Catches schema drift between up() and down() (e.g. missing index, extra
 *   trigger, wrong CHECK constraint after a table rebuild).
 * - Catches FTS-trigger loss/leak in migration 005's table-rebuild down().
 * - Catches broken down() implementations that fail to run at all
 *   (e.g. ALTER TABLE DROP COLUMN refusing to drop a column an index still
 *   references — discovered in migration 002 while authoring this test).
 *
 * Data-preservation note:
 *   The tasks DB has irreversible migrations by design — 001's down() drops
 *   every user table, and 003-007 all destructively drop columns/tables that
 *   they introduced. Asserting row-count preservation across destructive
 *   down()/up() pairs on seeded data would require either making those
 *   migrations data-preserving (out of scope) or skipping the assertion.
 *   Instead, the round-trip below runs against an EMPTY schema, so all row
 *   counts are zero and trivially preserved. The schema (the part that
 *   matters for drift detection) is fully covered.
 *
 *   Data-preservation of specific tables is verified separately by the
 *   per-migration tests in this same directory (migration-005.test.ts already
 *   checks tasks-table preservation across the 005 table-rebuild). The
 *   `migration 005 specifically — FTS trigger restoration` block below seeds
 *   data after the round-trip to functionally validate the triggers fire.
 *
 * Requirements:
 *   Migration 007 uses ALTER TABLE ... DROP COLUMN (SQLite 3.35+). better-sqlite3
 *   12.x bundles SQLite 3.46+, satisfied by package.json's ^12.6.2 declaration.
 *   No additional version pinning is required here.
 */

// Migration file glob — kept in sync with src/db/migrate.ts.
// In tests we always execute under tsx, so the source is .ts.
function listMigrationFiles(): string[] {
  const migrationsDir = join(__dirname, '..', 'migrations');
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{3}-.*\.ts$/.test(f))
    .sort();
}

interface MigrationModule {
  up: (db: Database.Database) => void | Promise<void>;
  down: (db: Database.Database) => void | Promise<void>;
}

/**
 * Dynamically import a migration by filename. We import via an absolute
 * file:// URL so vite's dynamic-import-vars plugin doesn't try to enumerate
 * the relative-path glob; tsx then loads the .ts source directly. This
 * mirrors how src/db/migrate.ts loads migrations at runtime.
 */
async function loadMigration(filename: string): Promise<MigrationModule> {
  const absolutePath = join(MIGRATIONS_DIR, filename);
  const url = pathToFileURL(absolutePath).href;
  return (await import(/* @vite-ignore */ url)) as MigrationModule;
}

/**
 * Capture a canonical, comparable representation of the database's schema +
 * data shape. Two databases compare equal IFF they have:
 *   - the same set of (name, type, tbl_name, sql) rows in sqlite_master, AND
 *   - the same row count for each user table.
 *
 * sqlite_master rows from the internal `sqlite_*` family (e.g. sqlite_sequence)
 * are excluded — they change opportunistically based on AUTOINCREMENT usage
 * rather than schema definition. FTS5 shadow tables (tasks_fts_*) ARE
 * included — their presence/absence is exactly what migration 005's
 * table-rebuild round-trip needs to validate.
 */
interface DbSnapshot {
  schema: Array<{ name: string; type: string; tbl_name: string; sql: string | null }>;
  rowCounts: Record<string, number>;
}

function snapshotDb(db: Database.Database): DbSnapshot {
  const schema = db
    .prepare(
      `SELECT name, type, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ name: string; type: string; tbl_name: string; sql: string | null }>;

  // Only count rows in real tables (skip virtual FTS tables and indexes/triggers/views).
  // Virtual table row counts are implicitly verified via the underlying content table.
  // Skip the _migrations bookkeeping table — we apply migrations directly here,
  // not through umzug, so it's empty and uninteresting.
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name NOT LIKE 'sqlite_%'
         AND name != '_migrations'
         AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  const rowCounts: Record<string, number> = {};
  for (const { name } of tables) {
    const row = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number };
    rowCounts[name] = row.c;
  }

  return { schema, rowCounts };
}

/**
 * Apply migrations 001..targetIndex (inclusive) by direct up() calls.
 * This sidesteps umzug's storage table so each test gets a clean schema
 * matching exactly what those migrations produce.
 */
async function applyMigrationsUpTo(
  db: Database.Database,
  files: string[],
  targetIndex: number,
): Promise<void> {
  for (let i = 0; i <= targetIndex; i++) {
    const mod = await loadMigration(files[i]);
    await mod.up(db);
  }
}

/**
 * Verify FTS triggers are healthy by inserting a row, searching for it via
 * FTS, deleting it, and confirming it's gone from FTS. Used as a defensive
 * smoke test after the 005 round-trip since that migration rebuilds the
 * tasks table and must drop+restore the 3 FTS triggers.
 */
function assertFtsTriggersHealthy(db: Database.Database): void {
  const projectRes = db
    .prepare('INSERT INTO projects (name) VALUES (?)')
    .run('fts-healthcheck-project');
  const projectId = projectRes.lastInsertRowid as number;

  const taskRes = db
    .prepare(
      `INSERT INTO tasks (title, description, project_id, created_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run('FTS healthcheck pangolin', 'unique pangolin keyword', projectId, 'tester');
  const taskId = taskRes.lastInsertRowid as number;

  const hits = db
    .prepare(
      `SELECT tasks.id FROM tasks
       JOIN tasks_fts ON tasks.id = tasks_fts.rowid
       WHERE tasks_fts MATCH ?`,
    )
    .all('pangolin') as Array<{ id: number }>;
  expect(hits, 'FTS insert trigger must be present after round-trip').toHaveLength(1);
  expect(hits[0].id).toBe(taskId);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  const afterDelete = db
    .prepare(
      `SELECT tasks.id FROM tasks
       JOIN tasks_fts ON tasks.id = tasks_fts.rowid
       WHERE tasks_fts MATCH ?`,
    )
    .all('pangolin') as Array<{ id: number }>;
  expect(afterDelete, 'FTS delete trigger must be present after round-trip').toHaveLength(0);
}

/**
 * Count FTS-related triggers — guards against the specific failure mode where
 * migration 005's down() drops them but a buggy up() leaves them missing
 * (or duplicates them).
 */
function ftsTriggerNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='trigger' AND name LIKE 'tasks_fts_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

const MIGRATION_FILES = listMigrationFiles();

describe('Migration round-trip (up -> down -> up) with schema snapshot', () => {
  it('discovered the expected migration files', () => {
    // Sanity: if a new migration is added, the test will pick it up
    // automatically. This assertion just documents the minimum count at the
    // time of writing — a surprise drop surfaces here instead of as a
    // confusing per-migration snapshot diff.
    expect(MIGRATION_FILES.length).toBeGreaterThanOrEqual(7);
    expect(MIGRATION_FILES[0]).toMatch(/^001-/);
  });

  for (let i = 0; i < MIGRATION_FILES.length; i++) {
    const file = MIGRATION_FILES[i];
    const migrationName = file.replace(/\.ts$/, '');

    describe(migrationName, () => {
      it('schema is stable across down() -> up() round-trip', async () => {
        const db = initTestDatabase();
        try {
          // 1. Apply 001..i to build the state before round-trip.
          await applyMigrationsUpTo(db, MIGRATION_FILES, i);

          // 2. Capture canonical snapshot of schema + row counts.
          const before = snapshotDb(db);

          // 3. Round-trip the *current* migration.
          const current = await loadMigration(file);
          await current.down(db);
          await current.up(db);

          // 4. Capture again, assert exact equality.
          const after = snapshotDb(db);
          expect(after.schema, 'schema must round-trip exactly').toEqual(before.schema);
          expect(after.rowCounts, 'row counts must round-trip exactly').toEqual(before.rowCounts);

          // 5. Commit canonical schema to the repo via vitest snapshot so any
          //    drift in net migration output surfaces in the PR diff.
          expect(before.schema).toMatchSnapshot('schema');
        } finally {
          db.close();
        }
      });
    });
  }

  describe('populated-DB forward migration (M2 — v2.0 release blocker)', () => {
    // The per-migration round-trip above runs on an EMPTY schema, so it proves
    // schema stability but NOT that real data survives a forward upgrade. M2
    // closes that gap: seed a representative populated DB at an EARLY schema
    // state (just after migration 003, which is the first to include
    // task_comments), then run EVERY remaining migration forward to the 2.0
    // schema and assert all seeded rows survive.
    it('preserves projects/tasks/comments rows when migrating an early-schema populated DB to 2.0', async () => {
      // Migration 003 is the earliest schema that has projects + tasks +
      // task_comments — the three row classes we assert on.
      const idx003 = MIGRATION_FILES.findIndex((f) => /^003-/.test(f));
      expect(idx003, 'migration 003 must exist').toBeGreaterThanOrEqual(0);

      const db = initTestDatabase();
      try {
        // 1. Build the early schema (001..003) directly.
        await applyMigrationsUpTo(db, MIGRATION_FILES, idx003);

        // 2. Seed a representative, deterministic dataset.
        //    2 projects, 3 tasks (across both projects), 4 comments.
        const insertProject = db.prepare('INSERT INTO projects (name) VALUES (?)');
        const p1 = insertProject.run('alpha').lastInsertRowid as number;
        const p2 = insertProject.run('beta').lastInsertRowid as number;

        const insertTask = db.prepare(
          `INSERT INTO tasks (title, description, project_id, created_by)
           VALUES (?, ?, ?, ?)`,
        );
        const t1 = insertTask.run('task one', 'desc one', p1, 'alice').lastInsertRowid as number;
        const t2 = insertTask.run('task two', 'desc two', p1, 'bob').lastInsertRowid as number;
        const t3 = insertTask.run('task three', 'desc three', p2, 'carol')
          .lastInsertRowid as number;

        const insertComment = db.prepare(
          `INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?)`,
        );
        insertComment.run(t1, 'alice', 'first comment');
        insertComment.run(t1, 'bob', 'second comment');
        insertComment.run(t2, 'carol', 'third comment');
        insertComment.run(t3, 'alice', 'fourth comment');

        const expected = {
          projects: 2,
          tasks: 3,
          task_comments: 4,
        };

        // Sanity: the seed landed as intended before any forward migration.
        for (const [table, count] of Object.entries(expected)) {
          const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
          expect(row.c, `seed precondition for ${table}`).toBe(count);
        }

        // 3. Run EVERY remaining migration forward (004..last) — the real
        //    upgrade path an existing 1.x DB takes to reach the 2.0 schema.
        for (let i = idx003 + 1; i < MIGRATION_FILES.length; i++) {
          const mod = await loadMigration(MIGRATION_FILES[i]);
          await mod.up(db);
        }

        // 4. All seeded rows must survive the full forward migration.
        for (const [table, count] of Object.entries(expected)) {
          const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
          expect(row.c, `${table} rows must be preserved through forward migration`).toBe(count);
        }

        // 5. Spot-check that representative cell data (not just row counts)
        //    survived — guards a migration that drops/renames a column.
        const task = db.prepare('SELECT title, created_by FROM tasks WHERE id = ?').get(t1) as
          | { title: string; created_by: string }
          | undefined;
        expect(task?.title).toBe('task one');
        expect(task?.created_by).toBe('alice');

        const comment = db
          .prepare(
            'SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id LIMIT 1',
          )
          .get(t1) as { author: string; content: string } | undefined;
        expect(comment?.author).toBe('alice');
        expect(comment?.content).toBe('first comment');
      } finally {
        db.close();
      }
    });
  });

  describe('migration 005 specifically — FTS trigger restoration', () => {
    // This block is targeted at the FTS table-rebuild down() path. Even though
    // the generic schema snapshot above would also catch a missing trigger,
    // we want a clearly named test so a regression in 005 is obvious from the
    // test name alone, and we want a *functional* check that the restored
    // triggers actually fire (not just that their CREATE TRIGGER row exists
    // in sqlite_master).
    it('down() then up() leaves exactly the 3 FTS triggers in place AND firing', async () => {
      const idx005 = MIGRATION_FILES.findIndex((f) => /^005-/.test(f));
      expect(idx005, 'migration 005 must exist').toBeGreaterThanOrEqual(0);

      const db = initTestDatabase();
      try {
        await applyMigrationsUpTo(db, MIGRATION_FILES, idx005);

        const expectedTriggers = ['tasks_fts_delete', 'tasks_fts_insert', 'tasks_fts_update'];

        expect(ftsTriggerNames(db)).toEqual(expectedTriggers);

        const m005 = await loadMigration(MIGRATION_FILES[idx005]);
        await m005.down(db);

        // After down(): migration 005 reverts to the pre-005 schema, which
        // (per migration 001) still includes all 3 FTS triggers. A leak that
        // dropped them without restoration would fail here.
        expect(ftsTriggerNames(db), 'down() must restore FTS triggers').toEqual(expectedTriggers);

        await m005.up(db);

        expect(ftsTriggerNames(db), 'up() must restore FTS triggers').toEqual(expectedTriggers);

        // Functional smoke test — make sure the triggers actually fire and
        // aren't just orphaned definitions referencing a stale tasks table.
        assertFtsTriggersHealthy(db);
      } finally {
        db.close();
      }
    });
  });
});
