/**
 * Task #705 — end-to-end config-path regression coverage.
 *
 * Builds on the two prior fixes:
 *   - #703: `src/api/start.ts` calls `createServer({ dbPath: config.DATABASE_PATH })`,
 *     and `createServer` forwards `dbPath` into `createApp` → `initDatabase`.
 *   - #704: `src/db/migrate.ts` exposes `resolveMigrateDbPath`/`migrateCli`,
 *     honoring `DATABASE_PATH` with a `./data/tasks.db` fallback.
 *
 * The narrow regression this file guards against is the original incident: the
 * migration CLI and the API server opening DIFFERENT databases. These tests
 * prove that, given ONE configured `DATABASE_PATH`, BOTH paths converge on the
 * SAME absolute file:
 *
 *   (a) migrate ENV OVERRIDE     — `migrateCli` opens/migrates the DATABASE_PATH file.
 *   (b) migrate DEFAULT FALLBACK — unset DATABASE_PATH ⇒ ./data/tasks.db under cwd.
 *   (c) API STARTUP plumbing     — `createServer({ dbPath })` (the exact call
 *       `start.ts` makes with `config.DATABASE_PATH`) reaches `initDatabase`,
 *       so the live `app.db.name` equals the configured path; and that path is
 *       the SAME file `migrateCli` targeted for the same config.
 *
 * Safety: every assertion runs against a throwaway temp dir created with
 * `fs.mkdtempSync(os.tmpdir(), ...)`. Nothing here reads or mutates the real
 * `data/` directory or any `/opt` database. We NEVER import `start.ts`
 * (it self-starts a real server at module load); the API plumbing is exercised
 * via `createServer({ dbPath })` directly, which is precisely the call
 * `start.ts` makes with `config.DATABASE_PATH`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import Database from '../db/driver.js';
import { resolveMigrateDbPath, migrateCli } from '../db/migrate.js';
import { createApp, type App } from '../index.js';
import { createServer } from '../api/server.js';

// createServer builds a full Fastify instance, which forces the env Proxy to
// validate config (API_KEYS is required). Same harness convention as the
// existing real-createServer tests (helmet.test.ts, tasks.test.ts).
process.env.API_KEYS = 'test-key';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wft-config-e2e-705-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A migrated DB should exist and contain both the migrations bookkeeping table
 * and at least one real schema table (`tasks`).
 */
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

describe('Task #705 — migrate and API startup share the configured DB path', () => {
  it('(a) migrate ENV OVERRIDE: migrateCli opens/migrates the DATABASE_PATH file', async () => {
    const target = join(tmpRoot, 'override', 'tasks.db');
    expect(existsSync(target)).toBe(false);

    const returned = await migrateCli({ DATABASE_PATH: target }, tmpRoot);

    // The CLI resolves and targets exactly the configured path (absolute).
    expect(returned).toBe(resolve(target));
    // The pure resolver agrees with the CLI's chosen path.
    expect(resolveMigrateDbPath({ DATABASE_PATH: target }, tmpRoot)).toBe(
      returned,
    );
    assertMigrated(target);
    // The default location must NOT have been created — proves no hardcoding.
    expect(existsSync(join(tmpRoot, 'data', 'tasks.db'))).toBe(false);
  });

  it('(b) migrate DEFAULT FALLBACK: unset DATABASE_PATH ⇒ ./data/tasks.db under cwd', async () => {
    const returned = await migrateCli({}, tmpRoot);

    const expected = join(tmpRoot, 'data', 'tasks.db');
    expect(returned).toBe(expected);
    // Guards against a hardcoded path escaping the throwaway temp cwd.
    expect(returned.endsWith(`data${sep}tasks.db`)).toBe(true);
    expect(returned.startsWith(tmpRoot)).toBe(true);
    expect(statSync(join(tmpRoot, 'data')).isDirectory()).toBe(true);
    assertMigrated(expected);
  });

  it('(c) API STARTUP: createServer({ dbPath }) plumbs config.DATABASE_PATH to the DB open', async () => {
    // This is the exact shape start.ts uses: createServer({ dbPath: config.DATABASE_PATH }).
    const dbPath = join(tmpRoot, 'api', 'tasks.db');
    // createApp/initDatabase opens the file directly; the parent dir is an
    // operator/deploy precondition (migrateCli is what creates ./data). Mirror
    // that by ensuring the dir exists before boot.
    mkdirSync(dirname(dbPath), { recursive: true });

    const { server, app } = await createServer({ dbPath });
    try {
      // The live server's DB handle opened the configured path — proving the
      // option threads createServer → createApp → initDatabase. better-sqlite3
      // exposes the opened file as `db.name`.
      expect(app.db.name).toBe(dbPath);
      expect(server.db.name).toBe(dbPath);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      await server.close();
      app.dispose();
    }
  });

  it('(c) API STARTUP: createApp(dbPath) opens exactly the configured path', async () => {
    // createServer delegates dbPath straight to createApp(options?.dbPath);
    // assert that delegate directly so the plumbing is pinned at both layers.
    const dbPath = join(tmpRoot, 'app-layer', 'tasks.db');
    mkdirSync(dirname(dbPath), { recursive: true });

    let app: App | undefined;
    try {
      app = await createApp(dbPath);
      expect(app.db.name).toBe(dbPath);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      app?.dispose();
    }
  });

  it('CONVERGENCE: migrate and API startup open the SAME file for one configured path', async () => {
    // One operator-configured DATABASE_PATH, used for BOTH subsystems.
    const configuredPath = join(tmpRoot, 'shared', 'tasks.db');

    // 1. The migration CLI targets it (the resolver is what migrateCli uses).
    const migratePath = resolveMigrateDbPath(
      { DATABASE_PATH: configuredPath },
      tmpRoot,
    );
    await migrateCli({ DATABASE_PATH: configuredPath }, tmpRoot);

    // 2. The API server (via the start.ts-shaped call) opens it too.
    const { server, app } = await createServer({ dbPath: configuredPath });
    try {
      const apiPath = app.db.name;

      // Both subsystems resolved to the identical absolute file — the core
      // anti-regression guarantee of #703 + #704 working together.
      expect(migratePath).toBe(resolve(configuredPath));
      expect(apiPath).toBe(resolve(configuredPath));
      expect(apiPath).toBe(migratePath);
      assertMigrated(configuredPath);
    } finally {
      await server.close();
      app.dispose();
    }
  });
});
