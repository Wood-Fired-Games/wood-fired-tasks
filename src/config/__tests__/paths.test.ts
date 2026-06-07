import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * task #731 + v2.0 release-blocker C1/H1 — verify the env-paths-backed default
 * DB path AND the unified resolver precedence (env > legacy-adopt > app-data).
 *
 * env.ts captures `DATABASE_PATH` via Zod's `.default(() => resolveDbPath())`
 * at parse time, so each test sets the desired env shape, then dynamically
 * imports a fresh copy of env.ts (after `vi.resetModules()`) and parses.
 *
 * Because the resolver probes `process.cwd()` for a legacy `./data/tasks.db`,
 * the schema-default tests that assert the app-data fallback chdir into a clean
 * temp dir (with NO ./data/tasks.db) so the repo's own data/ directory cannot
 * make the result non-deterministic.
 */
describe('config/paths — DATABASE_PATH default resolution', () => {
  const ORIGINAL = process.env.DATABASE_PATH;
  const ORIGINAL_CWD = process.cwd();

  beforeEach(() => {
    delete process.env.DATABASE_PATH;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = ORIGINAL;
    }
    process.chdir(ORIGINAL_CWD);
    vi.resetModules();
  });

  it('paths module exports absolute dataDir/configDir/defaultDbPath', async () => {
    const paths = await import('../paths.js');
    expect(path.isAbsolute(paths.dataDir)).toBe(true);
    expect(path.isAbsolute(paths.configDir)).toBe(true);
    expect(path.isAbsolute(paths.defaultDbPath)).toBe(true);
    expect(paths.defaultDbPath).toBe(path.join(paths.dataDir, 'tasks.db'));
  });

  it('explicit DATABASE_PATH override wins over the app-data default', async () => {
    try {
      process.env.DATABASE_PATH = '/tmp/override.db';
      vi.resetModules();
      const { configSchema } = await import('../env.js');
      const parsed = configSchema.parse({ ...process.env });
      expect(parsed.DATABASE_PATH).toBe('/tmp/override.db');
    } finally {
      delete process.env.DATABASE_PATH;
    }
  });

  it('default DB path is absolute, outside cwd, and not ./data/tasks.db (no legacy file)', async () => {
    // Run from a clean temp cwd so the resolver's legacy probe finds nothing
    // and falls through to the app-data default.
    const clean = mkdtempSync(path.join(tmpdir(), 'wft-paths-clean-'));
    try {
      process.chdir(clean);
      delete process.env.DATABASE_PATH;
      vi.resetModules();
      const { configSchema } = await import('../env.js');
      const { defaultDbPath } = await import('../paths.js');

      const env = { ...process.env };
      delete env.DATABASE_PATH;
      const parsed = configSchema.parse({ ...env });

      expect(parsed.DATABASE_PATH).toBe(defaultDbPath);
      expect(path.isAbsolute(parsed.DATABASE_PATH)).toBe(true);
      expect(parsed.DATABASE_PATH).not.toBe('./data/tasks.db');
      expect(parsed.DATABASE_PATH.startsWith(clean)).toBe(false);
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(clean, { recursive: true, force: true });
    }
  });
});

describe('resolveDbPath — unified precedence (C1/H1)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'wft-resolve-'));
    const { _resetDbPathWarning } = await import('../db-path.js');
    _resetDbPathWarning();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedLegacy(root: string): string {
    const dir = path.join(root, 'data');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'tasks.db');
    writeFileSync(file, '');
    return file;
  }

  it('(1) explicit non-empty DATABASE_PATH wins — even when a legacy file exists', async () => {
    seedLegacy(tmpRoot);
    const { resolveDbPath } = await import('../db-path.js');
    expect(resolveDbPath({ DATABASE_PATH: '/explicit/db.sqlite' }, tmpRoot)).toBe(
      '/explicit/db.sqlite',
    );
  });

  it('(1) :memory: is treated as an explicit value', async () => {
    seedLegacy(tmpRoot);
    const { resolveDbPath } = await import('../db-path.js');
    expect(resolveDbPath({ DATABASE_PATH: ':memory:' }, tmpRoot)).toBe(':memory:');
  });

  it('(1) deprecated DB_PATH alias is honoured when DATABASE_PATH is unset', async () => {
    const { resolveDbPath } = await import('../db-path.js');
    expect(resolveDbPath({ DB_PATH: '/legacy-alias/db.sqlite' }, tmpRoot)).toBe(
      '/legacy-alias/db.sqlite',
    );
  });

  it('(2) adopts legacy ./data/tasks.db when present and app-data DB absent, and warns once', async () => {
    const legacy = seedLegacy(tmpRoot);
    const { resolveDbPath } = await import('../db-path.js');
    const { defaultDbPath } = await import('../paths.js');

    // Deterministic via the existence-probe seam: legacy present, app-data absent.
    const exists = (p: string) => p === legacy;
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(resolveDbPath({}, tmpRoot, exists)).toBe(legacy);
    // Second call must NOT warn again (one-time latch).
    expect(resolveDbPath({}, tmpRoot, exists)).toBe(legacy);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('legacy ./data/tasks.db');
    expect(warn.mock.calls[0]![0]).toContain(defaultDbPath);
  });

  it('(3) falls back to the app-data default when neither env nor legacy file is present', async () => {
    const { resolveDbPath } = await import('../db-path.js');
    const { defaultDbPath } = await import('../paths.js');
    // Nothing exists per the probe seam.
    expect(resolveDbPath({}, tmpRoot, () => false)).toBe(defaultDbPath);
  });

  it('does NOT adopt the legacy file when the app-data DB already exists', async () => {
    const { resolveDbPath } = await import('../db-path.js');
    const { defaultDbPath } = await import('../paths.js');
    // Both legacy and app-data DB "exist" — the already-migrated app-data DB
    // must win so a migrated install is never overridden by a stale legacy file.
    expect(resolveDbPath({}, tmpRoot, () => true)).toBe(defaultDbPath);
  });
});
