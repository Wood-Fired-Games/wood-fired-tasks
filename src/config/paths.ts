import path from 'node:path';
import envPaths from 'env-paths';

/**
 * OS-correct application data / config directories for Wood Fired Tasks.
 *
 * Backed by the `env-paths` package, which resolves to the platform's
 * canonical locations:
 *   - Windows: `%APPDATA%\wood-fired-tasks`
 *   - macOS:   `~/Library/Application Support/wood-fired-tasks`
 *   - Linux:   `$XDG_DATA_HOME/wood-fired-tasks` (or `~/.local/share/...`)
 *
 * The `{ suffix: '' }` option keeps the directory name `wood-fired-tasks`
 * rather than the default `wood-fired-tasks-nodejs`.
 *
 * All exported paths are ABSOLUTE.
 */
const paths = envPaths('wood-fired-tasks', { suffix: '' });

/** Absolute OS app-data directory for persistent state (the DB lives here). */
export const dataDir: string = paths.data;

/** Absolute OS config directory for user/operator configuration. */
export const configDir: string = paths.config;

/**
 * Default absolute path for the SQLite database, under the OS app-data dir.
 * Used as the `DATABASE_PATH` default when no explicit override is set.
 */
export const defaultDbPath: string = path.join(dataDir, 'tasks.db');

// NOTE: the unified DB-path resolver lives in `src/config/db-path.ts` and is
// imported directly from there by every consumer (it imports `defaultDbPath`
// from this file, so re-exporting it here would create a paths<->db-path
// import cycle that dependency-cruiser rejects).
