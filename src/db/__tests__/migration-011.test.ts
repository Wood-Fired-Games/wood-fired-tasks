import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from 'better-sqlite3';

/**
 * Integration tests for migration 011: tasks.acceptance_criteria column.
 *
 * Verifies (Wave 1.3 of the Tasks System Reliability milestone):
 *  - tasks.acceptance_criteria exists as a nullable TEXT column.
 *  - No CHECK / DEFAULT / UNIQUE constraints — plain free-form text.
 *  - Existing rows (inserted with no acceptance_criteria) load with NULL.
 *  - Rows can round-trip a populated value (including multi-line markdown).
 *  - The 5000-char Zod cap is the schema-layer business rule; the DB itself
 *    accepts longer strings (so the cap can be relaxed without a migration).
 *  - down() drops the column.
 *  - up() after down() restores the schema (round-trip).
 */
describe('migration 011: tasks.acceptance_criteria', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('adds tasks.acceptance_criteria as nullable TEXT', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === 'acceptance_criteria');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    // No default value — caller must supply explicit NULL or text.
    expect(col?.dflt_value).toBeNull();
  });

  it('existing rows (inserted without acceptance_criteria) load with NULL value', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    // Insert a task without specifying acceptance_criteria — back-compat path.
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('legacy task', projectId, 'tester').lastInsertRowid as number;

    const row = db
      .prepare('SELECT acceptance_criteria FROM tasks WHERE id = ?')
      .get(taskId) as { acceptance_criteria: string | null };
    expect(row.acceptance_criteria).toBeNull();
  });

  it('round-trips a populated value (single line)', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by, acceptance_criteria)
         VALUES (?, ?, ?, ?)`
      )
      .run('t', projectId, 'tester', 'Build green; tests pass.')
      .lastInsertRowid as number;

    const row = db
      .prepare('SELECT acceptance_criteria FROM tasks WHERE id = ?')
      .get(taskId) as { acceptance_criteria: string | null };
    expect(row.acceptance_criteria).toBe('Build green; tests pass.');
  });

  it('round-trips multi-line markdown', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const md = [
      '## Acceptance',
      '',
      '- [ ] Column exists',
      '- [ ] Migration round-trip passes',
      '',
      '### Notes',
      '',
      'Multi-line plain markdown should survive verbatim.',
    ].join('\n');

    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by, acceptance_criteria)
         VALUES (?, ?, ?, ?)`
      )
      .run('t', projectId, 'tester', md).lastInsertRowid as number;

    const row = db
      .prepare('SELECT acceptance_criteria FROM tasks WHERE id = ?')
      .get(taskId) as { acceptance_criteria: string | null };
    expect(row.acceptance_criteria).toBe(md);
  });

  it('updating acceptance_criteria from NULL -> value -> NULL works', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('t', projectId, 'tester').lastInsertRowid as number;

    db.prepare('UPDATE tasks SET acceptance_criteria = ? WHERE id = ?').run(
      'first revision',
      taskId
    );
    expect(
      (
        db
          .prepare('SELECT acceptance_criteria FROM tasks WHERE id = ?')
          .get(taskId) as { acceptance_criteria: string | null }
      ).acceptance_criteria
    ).toBe('first revision');

    db.prepare('UPDATE tasks SET acceptance_criteria = NULL WHERE id = ?').run(
      taskId
    );
    expect(
      (
        db
          .prepare('SELECT acceptance_criteria FROM tasks WHERE id = ?')
          .get(taskId) as { acceptance_criteria: string | null }
      ).acceptance_criteria
    ).toBeNull();
  });

  it('down() drops acceptance_criteria column', async () => {
    const { down } = await import('../migrations/011-acceptance-criteria.js');
    await down(db);

    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('acceptance_criteria');
    // Sanity: unrelated columns survive.
    expect(names).toContain('title');
    expect(names).toContain('description');
    expect(names).toContain('project_id');
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    // This roundtrip must be measured against a database that has ONLY
    // migrations 001-011 applied — running it on top of `runMigrations(db)`
    // (which applies every migration including 012, 013, ...) would let a
    // later migration's column survive the 011 round-trip and re-appear at
    // the end of the tasks row, producing a column-order diff that has
    // nothing to do with 011 itself.
    //
    // We tear down the shared db (which already had every migration applied
    // by beforeEach) and re-create a clean one with only 001-011 applied.
    db.close();
    db = initTestDatabase();
    for (let i = 1; i <= 11; i++) {
      const filename = `${String(i).padStart(3, '0')}-*`;
      const { readdirSync } = await import('fs');
      const { join, dirname } = await import('path');
      const { fileURLToPath, pathToFileURL } = await import('url');
      const here = dirname(fileURLToPath(import.meta.url));
      const migrationsDir = join(here, '..', 'migrations');
      const match = readdirSync(migrationsDir).find((f) =>
        f.startsWith(filename.slice(0, 4))
      );
      if (!match) throw new Error(`migration ${i} not found`);
      const mod = (await import(
        /* @vite-ignore */ pathToFileURL(join(migrationsDir, match)).href
      )) as { up: (db: Database.Database) => void | Promise<void> };
      await mod.up(db);
    }

    const before = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='tasks'`
      )
      .all();

    const { up, down } = await import(
      '../migrations/011-acceptance-criteria.js'
    );
    await down(db);
    await up(db);

    const after = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='tasks'`
      )
      .all();

    expect(after).toEqual(before);
  });
});
