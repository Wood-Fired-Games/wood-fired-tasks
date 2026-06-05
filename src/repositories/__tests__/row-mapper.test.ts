import { describe, it, expect, beforeEach } from 'vitest';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { mapRow, mapRows } from '../row-mapper.js';

/**
 * The mapRow/mapRows helpers wrap better-sqlite3's `.get()` / `.all()` so
 * the "unknown -> T" cast lives in one place. These tests pin the behaviour
 * we rely on so a future change to the helper doesn't silently break
 * every repository that calls them.
 */
describe('row-mapper', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initDatabase(':memory:');
    await runMigrations(db);
  });

  describe('mapRow', () => {
    it('returns undefined when the query matches no row', () => {
      const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
      const result = mapRow<{ id: number; name: string }>(stmt, 99_999);
      expect(result).toBeUndefined();
    });

    it('returns the row typed as T when the query matches', () => {
      db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)').run(
        'row-mapper-test',
        'one-row',
      );
      const stmt = db.prepare('SELECT * FROM projects WHERE name = ?');
      const result = mapRow<{ id: number; name: string }>(
        stmt,
        'row-mapper-test',
      );
      expect(result).toBeDefined();
      expect(result?.name).toBe('row-mapper-test');
    });

    it('works for aggregate single-row queries (e.g. COUNT)', () => {
      db.prepare('INSERT INTO projects (name) VALUES (?)').run('a');
      db.prepare('INSERT INTO projects (name) VALUES (?)').run('b');
      const stmt = db.prepare('SELECT COUNT(*) as count FROM projects');
      const result = mapRow<{ count: number }>(stmt);
      expect(result?.count).toBe(2);
    });
  });

  describe('mapRows', () => {
    it('returns an empty array when no rows match', () => {
      const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
      const result = mapRows<{ id: number }>(stmt, 99_999);
      expect(result).toEqual([]);
    });

    it('returns all matching rows typed as T[]', () => {
      db.prepare('INSERT INTO projects (name) VALUES (?)').run('alpha');
      db.prepare('INSERT INTO projects (name) VALUES (?)').run('beta');
      const stmt = db.prepare('SELECT name FROM projects ORDER BY name');
      const result = mapRows<{ name: string }>(stmt);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('alpha');
      expect(result[1].name).toBe('beta');
    });

    it('supports named-parameter binding', () => {
      db.prepare('INSERT INTO projects (name) VALUES (?)').run('gamma');
      const stmt = db.prepare(
        'SELECT name FROM projects WHERE name = @name',
      );
      const result = mapRows<{ name: string }>(stmt, { name: 'gamma' });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('gamma');
    });
  });
});
