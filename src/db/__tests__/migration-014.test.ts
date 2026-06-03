import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from 'better-sqlite3';

/**
 * Integration tests for migration 014: projects.value_charter column.
 *
 * Verifies (WSJF Prioritization, Phase 3.1):
 *  - projects.value_charter exists as a nullable TEXT column.
 *  - No CHECK / DEFAULT / UNIQUE constraints — shape validation is enforced
 *    by ValueCharterSchema at the service boundary, not by SQLite.
 *  - Existing rows (inserted with no value_charter) load with NULL.
 *  - Rows can round-trip a populated JSON-string value (preserving structure).
 *  - down() drops the column.
 *  - up() after down() restores the schema (round-trip).
 */
describe('migration 014: projects.value_charter', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('adds projects.value_charter as nullable TEXT', () => {
    const cols = db
      .prepare("PRAGMA table_info('projects')")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === 'value_charter');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  });

  it('existing rows (inserted without value_charter) load with NULL value', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const row = db
      .prepare('SELECT value_charter FROM projects WHERE id = ?')
      .get(projectId) as { value_charter: string | null };
    expect(row.value_charter).toBeNull();
  });

  it('round-trips a populated JSON string verbatim', () => {
    const charter = JSON.stringify({
      mission: 'win the checkout wedge',
      value_themes: [
        { name: 'checkout reliability', weight: 8, description: 'no dropped carts' },
      ],
      time_context: 'launch window Q3',
      risk_posture: 'security + outage first',
      out_of_scope: ['marketing site'],
      interview_version: 1,
      updated_at: '2026-06-01T00:00:00.000Z',
    });

    const projectId = db
      .prepare('INSERT INTO projects (name, value_charter) VALUES (?, ?)')
      .run('p', charter).lastInsertRowid as number;

    const row = db
      .prepare('SELECT value_charter FROM projects WHERE id = ?')
      .get(projectId) as { value_charter: string | null };
    expect(row.value_charter).toBe(charter);
  });

  it('json_extract reads the persisted interview_version', () => {
    const charter = JSON.stringify({ mission: 'm', interview_version: 3 });
    const projectId = db
      .prepare('INSERT INTO projects (name, value_charter) VALUES (?, ?)')
      .run('p', charter).lastInsertRowid as number;

    const row = db
      .prepare(
        "SELECT json_extract(value_charter, '$.interview_version') AS v FROM projects WHERE id = ?"
      )
      .get(projectId) as { v: number };
    expect(row.v).toBe(3);
  });

  it('updating value_charter from NULL -> value -> NULL works', () => {
    const projectId = db
      .prepare('INSERT INTO projects (name) VALUES (?)')
      .run('p').lastInsertRowid as number;

    const charter = JSON.stringify({ mission: 'm', interview_version: 1 });
    db.prepare('UPDATE projects SET value_charter = ? WHERE id = ?').run(
      charter,
      projectId
    );
    expect(
      (
        db
          .prepare('SELECT value_charter FROM projects WHERE id = ?')
          .get(projectId) as { value_charter: string | null }
      ).value_charter
    ).toBe(charter);

    db.prepare('UPDATE projects SET value_charter = NULL WHERE id = ?').run(
      projectId
    );
    expect(
      (
        db
          .prepare('SELECT value_charter FROM projects WHERE id = ?')
          .get(projectId) as { value_charter: string | null }
      ).value_charter
    ).toBeNull();
  });

  it('down() drops value_charter column', async () => {
    const { down } = await import('../migrations/014-value-charter.js');
    await down(db);

    const cols = db
      .prepare("PRAGMA table_info('projects')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('value_charter');
    // Sanity: unrelated columns survive.
    expect(names).toContain('name');
    expect(names).toContain('description');
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    const before = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='projects'`
      )
      .all();

    const { up, down } = await import('../migrations/014-value-charter.js');
    await down(db);
    await up(db);

    const after = db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type='table' AND name='projects'`
      )
      .all();

    expect(after).toEqual(before);
  });
});
