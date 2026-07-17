import { describe, it, expect, beforeEach } from 'vitest';
import { initTestDatabase } from '../database.js';
import { runMigrations } from '../migrate.js';
import type Database from '../driver.js';

/**
 * Integration tests for migration 016: projects.model_policy column +
 * app_settings singleton.
 *
 * Verifies (Configurable Task Models, Task 3):
 *  - projects.model_policy exists as a nullable TEXT column (mirrors 014's
 *    value_charter): no CHECK / DEFAULT / NOT NULL — shape validation is
 *    enforced by ModelPolicySchema at the service boundary, not by SQLite.
 *  - app_settings exists with a model_policy_default TEXT column and a
 *    CHECK (id = 1) singleton constraint on the PK.
 *  - the seed row id=1 is present with model_policy_default NULL.
 *  - pre-existing project rows read model_policy as NULL (back-compat).
 *  - the model_policy column round-trips a populated JSON string verbatim.
 *  - down() drops app_settings and the model_policy column.
 *  - up() after down() restores the schema (round-trip).
 */
describe('migration 016: projects.model_policy + app_settings singleton', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = initTestDatabase();
    await runMigrations(db);
  });

  it('016 adds projects.model_policy and the app_settings singleton', () => {
    const cols = db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'model_policy')).toBe(true);

    const settings = db.prepare("PRAGMA table_info('app_settings')").all() as Array<{
      name: string;
    }>;
    expect(settings.some((c) => c.name === 'model_policy_default')).toBe(true);

    const row = db
      .prepare('SELECT id, model_policy_default FROM app_settings WHERE id = 1')
      .get() as { id: number; model_policy_default: string | null } | undefined;
    expect(row?.id).toBe(1);
    expect(row?.model_policy_default).toBeNull();
  });

  it('adds projects.model_policy as nullable TEXT with no DEFAULT', () => {
    const cols = db.prepare("PRAGMA table_info('projects')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const col = cols.find((c) => c.name === 'model_policy');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  });

  it('app_settings pins to a single row via CHECK (id = 1)', () => {
    // Inserting a second row with id != 1 must violate the CHECK constraint.
    expect(() =>
      db.prepare('INSERT INTO app_settings (id, model_policy_default) VALUES (2, NULL)').run(),
    ).toThrow();

    // The seeded id=1 row is the only row.
    const count = db.prepare('SELECT COUNT(*) AS c FROM app_settings').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('pre-existing project rows read model_policy as NULL', () => {
    const projectId = db.prepare('INSERT INTO projects (name) VALUES (?)').run('p')
      .lastInsertRowid as number;

    const row = db.prepare('SELECT model_policy FROM projects WHERE id = ?').get(projectId) as {
      model_policy: string | null;
    };
    expect(row.model_policy).toBeNull();
  });

  it('round-trips a populated model_policy JSON string verbatim', () => {
    const policy = JSON.stringify({ validation: { default: 'auto' } });

    const projectId = db
      .prepare('INSERT INTO projects (name, model_policy) VALUES (?, ?)')
      .run('p', policy).lastInsertRowid as number;

    const row = db.prepare('SELECT model_policy FROM projects WHERE id = ?').get(projectId) as {
      model_policy: string | null;
    };
    expect(row.model_policy).toBe(policy);
  });

  it('app_settings.model_policy_default round-trips a populated JSON string', () => {
    const policy = JSON.stringify({ default: 'sonnet' });
    db.prepare('UPDATE app_settings SET model_policy_default = ? WHERE id = 1').run(policy);

    const row = db.prepare('SELECT model_policy_default FROM app_settings WHERE id = 1').get() as {
      model_policy_default: string | null;
    };
    expect(row.model_policy_default).toBe(policy);
  });

  it('down() drops app_settings and the model_policy column', async () => {
    const { down } = await import('../migrations/016-model-policy.js');
    await down(db);

    const cols = db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('model_policy');
    // Sanity: unrelated columns survive.
    expect(names).toContain('name');
    expect(names).toContain('description');

    const appSettings = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_settings'")
      .all() as Array<{ name: string }>;
    expect(appSettings).toHaveLength(0);
  });

  it('up() after down() restores the schema (round-trip)', async () => {
    // Assert on the sorted SET of full projects column definitions — (name,
    // type, notnull, dflt_value, pk) tuples from PRAGMA table_info — not the
    // raw CREATE TABLE SQL. down() drops model_policy and up() re-appends it at
    // the END of the column list, so when a LATER migration (e.g. 017 scm) has
    // also added a projects column, the physical column ORDER legitimately
    // changes across the round-trip even though every column is restored.
    // Sorting by name makes the comparison order-insensitive while still
    // failing on any type / NOT NULL / DEFAULT / PRIMARY KEY drift that a
    // name-only set would miss. Mirrors the 014-value-charter round-trip test,
    // which was hardened the same way when 016 first landed after it. The
    // app_settings table (dropped + recreated wholesale by down()/up()) is
    // order-stable, so its raw SQL is still compared verbatim.
    interface ColumnDef {
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }
    const projectColumnDefs = () =>
      (db.prepare("PRAGMA table_info('projects')").all() as ColumnDef[])
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const appSettingsSql = () =>
      db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name = 'app_settings'").all();

    const beforeCols = projectColumnDefs();
    const beforeAppSettings = appSettingsSql();
    expect(beforeCols.map((c) => c.name)).toContain('model_policy');
    expect(beforeAppSettings).toHaveLength(1);

    const { up, down } = await import('../migrations/016-model-policy.js');
    await down(db);
    await up(db);

    const afterCols = projectColumnDefs();
    const afterAppSettings = appSettingsSql();
    expect(afterCols).toEqual(beforeCols);
    expect(afterCols.map((c) => c.name)).toContain('model_policy');
    expect(afterAppSettings).toEqual(beforeAppSettings);
  });
});
