import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from 'better-sqlite3';

/**
 * Integration tests for migration 013: WSJF scoring columns on `tasks`.
 *
 * Verifies (WSJF prioritization feature, project 30):
 *  - The four INTEGER component columns and five TEXT JSON columns exist as
 *    nullable columns with no DEFAULT.
 *  - The Fibonacci CHECK rejects an out-of-set value (wsjf_value = 4) and
 *    accepts a valid value (wsjf_value = 8).
 *  - Existing rows (inserted without WSJF fields) load with NULL values.
 *  - down() drops every column.
 *  - up() after down() restores the schema (round-trip).
 */
const INTEGER_COLUMNS = [
  'wsjf_value',
  'wsjf_time_criticality',
  'wsjf_risk_opportunity',
  'wsjf_job_size',
];

const TEXT_COLUMNS = [
  'wsjf_evidence',
  'wsjf_locked',
  'wsjf_source',
  'wsjf_classifications',
  'wsjf_features',
];

describe('migration 013: tasks WSJF columns', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  function makeProject(): number {
    return db.prepare('INSERT INTO projects (name) VALUES (?)').run('p')
      .lastInsertRowid as number;
  }

  it('adds the four INTEGER component columns as nullable, no default', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    for (const name of INTEGER_COLUMNS) {
      const col = cols.find((c) => c.name === name);
      expect(col, `column ${name} missing`).toBeDefined();
      expect(col?.type).toBe('INTEGER');
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
  });

  it('adds the five TEXT JSON columns as nullable, no default', () => {
    const cols = db
      .prepare("PRAGMA table_info('tasks')")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    for (const name of TEXT_COLUMNS) {
      const col = cols.find((c) => c.name === name);
      expect(col, `column ${name} missing`).toBeDefined();
      expect(col?.type).toBe('TEXT');
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
  });

  it('CHECK rejects an insert with wsjf_value = 4 (out of Fibonacci set)', () => {
    const projectId = makeProject();
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (title, project_id, created_by, wsjf_value)
           VALUES (?, ?, ?, ?)`
        )
        .run('bad', projectId, 'tester', 4)
    ).toThrow();
  });

  it('CHECK accepts a valid Fibonacci wsjf_value = 8', () => {
    const projectId = makeProject();
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by, wsjf_value)
         VALUES (?, ?, ?, ?)`
      )
      .run('good', projectId, 'tester', 8).lastInsertRowid as number;
    const row = db
      .prepare('SELECT wsjf_value FROM tasks WHERE id = ?')
      .get(taskId) as { wsjf_value: number };
    expect(row.wsjf_value).toBe(8);
  });

  it('CHECK rejects every other component column with value = 4', () => {
    const projectId = makeProject();
    for (const name of INTEGER_COLUMNS) {
      expect(
        () =>
          db
            .prepare(
              `INSERT INTO tasks (title, project_id, created_by, ${name})
               VALUES (?, ?, ?, ?)`
            )
            .run(`bad-${name}`, projectId, 'tester', 4),
        `column ${name} should reject 4`
      ).toThrow();
    }
  });

  it('existing rows (inserted without WSJF fields) load with NULL values', () => {
    const projectId = makeProject();
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by) VALUES (?, ?, ?)`
      )
      .run('legacy', projectId, 'tester').lastInsertRowid as number;

    const row = db
      .prepare(
        `SELECT ${[...INTEGER_COLUMNS, ...TEXT_COLUMNS].join(', ')}
         FROM tasks WHERE id = ?`
      )
      .get(taskId) as Record<string, unknown>;
    for (const name of [...INTEGER_COLUMNS, ...TEXT_COLUMNS]) {
      expect(row[name], `column ${name} should be NULL`).toBeNull();
    }
  });

  it('round-trips populated JSON metadata columns verbatim', () => {
    const projectId = makeProject();
    const evidence = JSON.stringify({ rationale: 'high user demand' });
    const taskId = db
      .prepare(
        `INSERT INTO tasks (title, project_id, created_by, wsjf_evidence)
         VALUES (?, ?, ?, ?)`
      )
      .run('t', projectId, 'tester', evidence).lastInsertRowid as number;
    const row = db
      .prepare('SELECT wsjf_evidence FROM tasks WHERE id = ?')
      .get(taskId) as { wsjf_evidence: string | null };
    expect(row.wsjf_evidence).toBe(evidence);
  });

  it('down() drops every WSJF column', async () => {
    const { down } = await import('../migrations/013-wsjf-fields.js');
    await down(db);

    const names = (
      db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const name of [...INTEGER_COLUMNS, ...TEXT_COLUMNS]) {
      expect(names, `column ${name} should be dropped`).not.toContain(name);
    }
    // Sanity: unrelated columns survive.
    expect(names).toContain('title');
    expect(names).toContain('project_id');
    expect(names).toContain('verification_evidence');
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    const before = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='tasks'`
      )
      .all();

    const { up, down } = await import('../migrations/013-wsjf-fields.js');
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
