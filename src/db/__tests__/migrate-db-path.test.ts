/**
 * Regression tests for task #704 — `npm run migrate` must honor DATABASE_PATH.
 *
 * Covers the two acceptance behaviors documented in the task:
 *   1. ENV OVERRIDE: when DATABASE_PATH is set, the migration CLI targets that
 *      exact path AND creates any missing parent directory.
 *   2. DEFAULT FALLBACK: when DATABASE_PATH is unset/empty, the CLI resolves to
 *      ./data/tasks.db relative to cwd (never overwriting a real DB — every
 *      assertion here runs against a throwaway temp cwd under os.tmpdir()).
 *
 * Both the pure path resolver (`resolveMigrateDbPath`) and the full
 * `migrateCli` (which opens the DB, ensures the dir, and runs migrations) are
 * exercised so the regression is documented end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import Database from '../driver.js';
import { resolveMigrateDbPath, migrateCli } from '../migrate.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wft-migrate-704-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A migrated DB should contain the migrations bookkeeping table and at least
 *  one real schema table (tasks). */
function assertMigrated(dbPath: string): void {
  expect(existsSync(dbPath)).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain('_migrations');
    expect(names).toContain('tasks');
  } finally {
    db.close();
  }
}

describe('resolveMigrateDbPath (AC#1/AC#2 path logic)', () => {
  it('honors an explicit DATABASE_PATH (AC#1)', () => {
    const target = join(tmpRoot, 'nested', 'custom.db');
    expect(resolveMigrateDbPath({ DATABASE_PATH: target }, tmpRoot)).toBe(
      resolve(target),
    );
  });

  it('resolves a relative DATABASE_PATH against cwd (AC#1)', () => {
    expect(
      resolveMigrateDbPath({ DATABASE_PATH: 'sub/dir/my.db' }, tmpRoot),
    ).toBe(join(tmpRoot, 'sub', 'dir', 'my.db'));
  });

  it('falls back to ./data/tasks.db when DATABASE_PATH is unset (AC#2)', () => {
    expect(resolveMigrateDbPath({}, tmpRoot)).toBe(
      join(tmpRoot, 'data', 'tasks.db'),
    );
  });

  it('falls back to ./data/tasks.db when DATABASE_PATH is empty (AC#2)', () => {
    expect(resolveMigrateDbPath({ DATABASE_PATH: '' }, tmpRoot)).toBe(
      join(tmpRoot, 'data', 'tasks.db'),
    );
  });
});

describe('migrateCli (AC#1/AC#2 end-to-end)', () => {
  it('creates the DATABASE_PATH file AND its missing parent dir (AC#1)', async () => {
    // Parent dir intentionally does not exist yet.
    const dir = join(tmpRoot, 'wft-smoke');
    const target = join(dir, 'tasks.db');
    expect(existsSync(dir)).toBe(false);

    const returned = await migrateCli({ DATABASE_PATH: target }, tmpRoot);

    expect(returned).toBe(resolve(target));
    expect(statSync(dir).isDirectory()).toBe(true);
    assertMigrated(target);
  });

  it('uses ./data/tasks.db under cwd when DATABASE_PATH is unset (AC#2)', async () => {
    const returned = await migrateCli({}, tmpRoot);

    const expected = join(tmpRoot, 'data', 'tasks.db');
    expect(returned).toBe(expected);
    // The path must end in data/tasks.db — guards against a hardcoded path
    // escaping the temp cwd.
    expect(returned.endsWith(`data${sep}tasks.db`)).toBe(true);
    expect(statSync(join(tmpRoot, 'data')).isDirectory()).toBe(true);
    assertMigrated(expected);
  });

  it('does not hardcode data/tasks.db when a custom path is given (AC#1 anti-regression)', async () => {
    const target = join(tmpRoot, 'elsewhere', 'app.sqlite');
    await migrateCli({ DATABASE_PATH: target }, tmpRoot);

    expect(existsSync(target)).toBe(true);
    // The default location must NOT have been created.
    expect(existsSync(join(tmpRoot, 'data', 'tasks.db'))).toBe(false);
  });
});
