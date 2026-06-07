/**
 * Regression tests for task #704 + v2.0 release-blocker C1/H1 —
 * `npm run migrate` must resolve its DB path through the SAME unified resolver
 * (`src/config/db-path.ts`) every other entry point uses, so migrate, the API
 * server, the MCP server, and the `tasks db*` CLI never open divergent files.
 *
 * Unified precedence (locked for 2.0):
 *   1. explicit non-empty DATABASE_PATH (or deprecated DB_PATH) wins;
 *   2. else legacy-adopt ./data/tasks.db when it exists AND the OS app-data DB
 *      does not (zero-data-loss upgrade guard, one-time warning);
 *   3. else the OS app-data default.
 *
 * `resolveMigrateDbPath` wraps the resolver and forces the result absolute
 * against `cwd`. Both it and the full `migrateCli` are exercised. Every
 * assertion runs against a throwaway temp cwd under os.tmpdir(); when a case
 * needs the env-unset-with-legacy branch it seeds a `data/tasks.db` inside that
 * temp dir, so the real `data/` directory is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import Database from '../driver.js';
import { resolveMigrateDbPath, migrateCli } from '../migrate.js';
import { defaultDbPath } from '../../config/paths.js';
import { _resetDbPathWarning } from '../../config/db-path.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wft-migrate-704-'));
  _resetDbPathWarning();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Seed an (empty) legacy ./data/tasks.db file inside `root`. */
function seedLegacyDb(root: string): string {
  const dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'tasks.db');
  writeFileSync(file, '');
  return file;
}

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

describe('resolveMigrateDbPath (unified-resolver path logic)', () => {
  it('honors an explicit DATABASE_PATH (precedence 1)', () => {
    const target = join(tmpRoot, 'nested', 'custom.db');
    expect(resolveMigrateDbPath({ DATABASE_PATH: target }, tmpRoot)).toBe(resolve(target));
  });

  it('resolves a relative DATABASE_PATH against cwd (precedence 1)', () => {
    expect(resolveMigrateDbPath({ DATABASE_PATH: 'sub/dir/my.db' }, tmpRoot)).toBe(
      join(tmpRoot, 'sub', 'dir', 'my.db'),
    );
  });

  it('adopts the legacy ./data/tasks.db when unset and that file exists (precedence 2)', () => {
    const legacy = seedLegacyDb(tmpRoot);
    // App-data DB does not exist (CI/dev), so the legacy file is adopted.
    expect(resolveMigrateDbPath({}, tmpRoot)).toBe(resolve(legacy));
  });

  it('adopts the legacy ./data/tasks.db when DATABASE_PATH is empty (precedence 2)', () => {
    const legacy = seedLegacyDb(tmpRoot);
    expect(resolveMigrateDbPath({ DATABASE_PATH: '' }, tmpRoot)).toBe(resolve(legacy));
  });

  it('falls back to the OS app-data default when unset and no legacy file exists (precedence 3)', () => {
    // No ./data/tasks.db seeded in tmpRoot; assumes the app-data DB is absent in
    // the test environment (true in CI/dev).
    expect(resolveMigrateDbPath({}, tmpRoot)).toBe(resolve(tmpRoot, defaultDbPath));
  });
});

describe('migrateCli (end-to-end)', () => {
  it('creates the DATABASE_PATH file AND its missing parent dir (precedence 1)', async () => {
    // Parent dir intentionally does not exist yet.
    const dir = join(tmpRoot, 'wft-smoke');
    const target = join(dir, 'tasks.db');
    expect(existsSync(dir)).toBe(false);

    const returned = await migrateCli({ DATABASE_PATH: target }, tmpRoot);

    expect(returned).toBe(resolve(target));
    expect(statSync(dir).isDirectory()).toBe(true);
    assertMigrated(target);
  });

  it('migrates the adopted legacy ./data/tasks.db when unset (precedence 2)', async () => {
    seedLegacyDb(tmpRoot);
    const returned = await migrateCli({}, tmpRoot);

    const expected = join(tmpRoot, 'data', 'tasks.db');
    expect(returned).toBe(expected);
    // The path must end in data/tasks.db — guards against a hardcoded path
    // escaping the temp cwd.
    expect(returned.endsWith(`data${sep}tasks.db`)).toBe(true);
    expect(statSync(join(tmpRoot, 'data')).isDirectory()).toBe(true);
    assertMigrated(expected);
  });

  it('does not hardcode data/tasks.db when a custom path is given (precedence-1 anti-regression)', async () => {
    const target = join(tmpRoot, 'elsewhere', 'app.sqlite');
    await migrateCli({ DATABASE_PATH: target }, tmpRoot);

    expect(existsSync(target)).toBe(true);
    // The default location must NOT have been created.
    expect(existsSync(join(tmpRoot, 'data', 'tasks.db'))).toBe(false);
  });
});
