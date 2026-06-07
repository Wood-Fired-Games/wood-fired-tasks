import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';

/**
 * task #731 — verify the env-paths-backed default DB path and the
 * explicit-override precedence.
 *
 * env.ts captures `DATABASE_PATH` via Zod's `.default()` at parse time, so
 * each test sets the desired env shape, then dynamically imports a fresh
 * copy of env.ts (after `vi.resetModules()`) and parses.
 */
describe('config/paths — DATABASE_PATH default resolution', () => {
  const ORIGINAL = process.env.DATABASE_PATH;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = ORIGINAL;
    }
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

  it('default DB path is absolute, outside the repo cwd, and not ./data/tasks.db', async () => {
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
    expect(parsed.DATABASE_PATH.startsWith(process.cwd())).toBe(false);
  });
});
