import { existsSync } from 'node:fs';
import path from 'node:path';
import { defaultDbPath } from './paths.js';

/**
 * Unified SQLite database-path resolver — the SINGLE source of truth every
 * entry point (API server, MCP stdio, migration CLI, and every `tasks db*`
 * CLI subcommand) must use so they never open divergent databases.
 *
 * Before 2.0 the entry points disagreed: `src/config/env.ts` defaulted to the
 * OS app-data path while `migrate.ts` / `mcp/index.ts` / the CLI commands
 * hardcoded `./data/tasks.db`. With `DATABASE_PATH` unset, `tasks serve`
 * targeted the app-data DB while `npm run migrate` / the MCP server targeted
 * the cwd-relative legacy file — silently splitting writes across two files
 * and abandoning an upgrading 1.15.0 user's `./data/tasks.db`.
 *
 * Resolution precedence (locked for the 2.0 release):
 *   1. An explicit, non-empty `DATABASE_PATH` env value wins outright. This
 *      includes `:memory:` and any operator-configured absolute/relative path.
 *      A deprecated `DB_PATH` alias is honoured second (older install.sh /
 *      install.ps1 ~/.claude.json installs wrote it before task #217).
 *   2. Otherwise, if a legacy `./data/tasks.db` (resolved against cwd) exists
 *      AND the OS app-data DB does NOT exist, adopt the legacy path and emit a
 *      loud one-time warning. This guarantees zero data loss for upgraders
 *      while never overriding a DB that has already migrated to app-data.
 *   3. Otherwise, the OS app-data default (`defaultDbPath`).
 *
 * The returned path is NOT forced absolute here (callers that need an absolute
 * path — e.g. the migration CLI — resolve it themselves) so that an explicit
 * relative `DATABASE_PATH` behaves exactly as the operator wrote it.
 */

/** Module-level guard so the legacy-adoption warning fires at most once per process. */
let warnedLegacyAdopt = false;

/**
 * Reset the one-time-warning latch. Test-only helper so suites that exercise
 * the warn-once behaviour can re-arm the latch between cases.
 */
export function _resetDbPathWarning(): void {
  warnedLegacyAdopt = false;
}

/**
 * Resolve the effective SQLite DB path per the locked 2.0 precedence.
 *
 * @param env - environment map (defaults to `process.env`).
 * @param cwd - base directory for the legacy `./data/tasks.db` probe
 *   (defaults to `process.cwd()`).
 * @param exists - filesystem existence probe (defaults to `fs.existsSync`).
 *   Injectable seam so the legacy-adopt vs app-data branches can be exercised
 *   deterministically in tests without touching the real filesystem.
 */
export function resolveDbPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  exists: (p: string) => boolean = existsSync,
): string {
  // (1) Explicit env wins — DATABASE_PATH first, deprecated DB_PATH alias next.
  const explicit = env['DATABASE_PATH'] || env['DB_PATH'];
  if (explicit && explicit.length > 0) {
    return explicit;
  }

  // (2) Legacy-adopt: a cwd-relative ./data/tasks.db exists AND the app-data
  // DB does not yet exist. Adopt the legacy file so an upgrader's data is not
  // silently abandoned, and warn loudly (once) so they know to pin it.
  const legacyPath = path.resolve(cwd, 'data', 'tasks.db');
  if (exists(legacyPath) && !exists(defaultDbPath)) {
    if (!warnedLegacyAdopt) {
      warnedLegacyAdopt = true;
      console.error(
        `[wft] DATABASE_PATH unset; using legacy ./data/tasks.db (${legacyPath}). ` +
          `Set DATABASE_PATH explicitly to silence this. ` +
          `The 2.0 default is the OS app-data dir (${defaultDbPath}).`,
      );
    }
    return legacyPath;
  }

  // (3) OS app-data default.
  return defaultDbPath;
}
