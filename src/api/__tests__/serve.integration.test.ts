import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Task #733 — `serve` integration test.
 *
 * Boots the API server the way `tasks serve` does (via the serve command's
 * exported `startServer` helper, which calls
 * `createServer({ dbPath: config.DATABASE_PATH })` then `server.listen`) and
 * proves three things, ALL from a working directory OUTSIDE the repo:
 *
 *   1. GET /health returns 200 (unauthenticated, public route).
 *   2. The app-data DB file materializes at the resolver-defaulted path
 *      (under a temp HOME), i.e. serve does NOT depend on cwd for the DB.
 *   3. Migrations ran into that DB before listening — a known table (`tasks`)
 *      exists, verified by opening the file read-only through the db driver
 *      seam (src/db/driver.js) and querying sqlite_master.
 *
 * Hermetic: a fresh temp HOME makes env-paths resolve the app-data dir under
 * the temp tree, and cwd is moved to os.tmpdir() so nothing resolves relative
 * to the repo. Modules are reset so env.ts/paths.ts re-read the patched HOME.
 */

describe('Task #733 — serve boots from any cwd, migrates app-data DB, /health 200', () => {
  let tmpHome: string;
  const origEnv = { ...process.env };
  const origCwd = process.cwd();

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'wft-serve-home-'));
  });

  afterEach(() => {
    // Restore env wholesale (covers HOME, XDG_*, API_KEYS, PORT, HOST, etc.).
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
    try {
      process.chdir(origCwd);
    } catch {
      // best-effort
    }
  });

  it('serves /health 200 and migrates the app-data DB when launched outside the repo', async () => {
    // --- Arrange a clean, repo-independent environment -------------------
    // Point HOME (and clear XDG overrides) at the temp tree so env-paths
    // resolves the app-data dir beneath it. Linux env-paths uses
    // XDG_DATA_HOME when set, so force it under the temp HOME for determinism.
    process.env.HOME = tmpHome;
    process.env.XDG_DATA_HOME = join(tmpHome, '.local', 'share');
    process.env.XDG_CONFIG_HOME = join(tmpHome, '.config');
    process.env.API_KEYS = 'test-key';
    process.env.PORT = '0'; // ephemeral port
    process.env.HOST = '127.0.0.1';
    process.env.NODE_ENV = 'test';
    // Crucially: do NOT set DATABASE_PATH — rely on the resolver default.
    delete process.env.DATABASE_PATH;

    // Move cwd outside the repo so any cwd-relative fallback would write the
    // wrong place (and the assertions below would then fail).
    process.chdir(tmpdir());

    // Reset the module registry so env.ts/paths.ts re-read the patched env.
    vi.resetModules();

    // Re-import AFTER env is patched and modules reset.
    const { defaultDbPath } = await import('../../config/paths.js');
    const { startServer } = await import('../../cli/commands/serve.js');

    // The resolved default DB path must live under the temp HOME, proving
    // cwd-independence (it is NOT ./data/tasks.db relative to cwd).
    expect(defaultDbPath.startsWith(tmpHome)).toBe(true);

    const booted = await startServer();
    const { server, app } = booted;

    try {
      // --- /health 200 -------------------------------------------------
      const addr = server.server.address();
      expect(addr).not.toBeNull();
      const port = typeof addr === 'object' && addr !== null ? addr.port : booted.port;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      // --- DB file exists at the resolver-defaulted app-data path ------
      expect(existsSync(defaultDbPath)).toBe(true);

      // --- Migrations ran: a known table exists ------------------------
      // Verify via the live app handle first (it opened the same file).
      const liveRow = app.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get() as { name?: string } | undefined;
      expect(liveRow?.name).toBe('tasks');

      // Independently re-open the file read-only through the driver seam and
      // assert the table is present on disk (not just in the live handle).
      const { default: Database } = await import('../../db/driver.js');
      const ro = new Database(defaultDbPath, { readonly: true });
      try {
        const row = ro
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
          .get() as { name?: string } | undefined;
        expect(row?.name).toBe('tasks');
      } finally {
        ro.close();
      }
    } finally {
      await server.close();
      try {
        app.db.close();
      } catch {
        // server.close()/shutdown may already have closed it
      }
    }
  });

  /**
   * Task #811 — serve boot emits a single structured OIDC-state log line.
   *
   * The state itself is resolved once at `createApp` time (src/index.ts
   * `OidcStatus`) and surfaced as `app.oidcStatus`; `startServer` emits it as
   * ONE pino line `{ oidc: <state> }` with the stable message "oidc boot
   * state". With NO OIDC_ISSUER_URL configured the state is `disabled`, so
   * this asserts both the line's presence and its value.
   *
   * Capture mechanism: in NODE_ENV=test the Fastify pino logger has no
   * pino-pretty transport and writes JSON to stdout, so we spy on
   * process.stdout.write and scan the captured chunks for our line.
   */
  it('emits a single structured OIDC-state boot log line reporting "disabled" when OIDC config is absent', async () => {
    // --- Arrange a clean, repo-independent environment, no OIDC ----------
    process.env.HOME = tmpHome;
    process.env.XDG_DATA_HOME = join(tmpHome, '.local', 'share');
    process.env.XDG_CONFIG_HOME = join(tmpHome, '.config');
    process.env.API_KEYS = 'test-key';
    process.env.PORT = '0';
    process.env.HOST = '127.0.0.1';
    process.env.NODE_ENV = 'test';
    delete process.env.DATABASE_PATH;
    // Crucially: OIDC config absent → oidcStatus.state must be "disabled".
    delete process.env.OIDC_ISSUER_URL;

    process.chdir(tmpdir());
    vi.resetModules();

    const { startServer } = await import('../../cli/commands/serve.js');

    // Capture stdout (pino destination in NODE_ENV=test).
    const captured: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });

    let booted: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      booted = await startServer();
    } finally {
      writeSpy.mockRestore();
    }

    try {
      // The boot-state line surfaces "disabled" via the live app handle.
      expect(booted.app.oidcStatus.state).toBe('disabled');

      // Find the single structured OIDC-state log line among captured stdout.
      const matches = captured
        .join('')
        .split('\n')
        .filter((line) => line.includes('oidc boot state'))
        .map((line) => JSON.parse(line) as { msg?: string; oidc?: string });

      // Exactly ONE such line, and its structured value is "disabled".
      expect(matches).toHaveLength(1);
      expect(matches[0]?.msg).toBe('oidc boot state');
      expect(matches[0]?.oidc).toBe('disabled');
    } finally {
      await booted.server.close();
      try {
        booted.app.db.close();
      } catch {
        // already closed
      }
    }
  });
});
