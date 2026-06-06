/**
 * CLI cache-path helper — owns the on-disk cache directory and the
 * cache-precedence resolver shared by the Phase 4 status-line infra
 * (per-project task-count cache + the update-available rollup writer).
 *
 * Mirrors the precedence model of `getCredentialsPath()`
 * (see src/cli/auth/credentials.ts), but anchored at the XDG *cache*
 * base directory instead of the config one:
 *
 * Path: `$WFT_CACHE_PATH` > `$XDG_CACHE_HOME/wood-fired-tasks`
 *       (when XDG_CACHE_HOME is an ABSOLUTE path per the XDG Base
 *       Directory spec) > `~/.cache/wood-fired-tasks`.
 *
 * The override env wins unconditionally when set & non-empty; this is
 * the test-isolation and power-user escape hatch. A *relative*
 * XDG_CACHE_HOME is ignored (the XDG spec mandates absolute paths) and
 * we fall through to `~/.cache`.
 *
 * Kept deliberately free of any harness/vendor names — only
 * `wood-fired-tasks` (the project) appears in the resolved path.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the absolute cache directory for this project.
 *
 * Precedence:
 *   1. `$WFT_CACHE_PATH` (verbatim) when set & non-empty.
 *   2. `$XDG_CACHE_HOME/wood-fired-tasks` when XDG_CACHE_HOME is absolute.
 *   3. `~/.cache/wood-fired-tasks`.
 */
export function getCacheDir(): string {
  const override = process.env['WFT_CACHE_PATH'];
  if (override && override.length > 0) return override;

  const xdg = process.env['XDG_CACHE_HOME'];
  const cacheHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache');
  return path.join(cacheHome, 'wood-fired-tasks');
}

/**
 * Per-project task-count cache file path under {@link getCacheDir}.
 *
 * The `projectKey` is sanitized to a filesystem-safe slug so an
 * arbitrary key (server URL, project id, slug) can't escape the cache
 * dir via path separators or traversal segments.
 */
export function getCountCachePath(projectKey: string): string {
  const slug = sanitizeKey(projectKey);
  return path.join(getCacheDir(), `count-${slug}.json`);
}

/**
 * Sibling update-available cache file path under {@link getCacheDir}.
 *
 * v2.0 rollup: reused by the Phase 4 update-check writer so the
 * status-line surfaces "update available" without an extra registry
 * round-trip on every render.
 */
export function getUpdateCheckPath(): string {
  return path.join(getCacheDir(), 'update-check.json');
}

/**
 * Collapse an arbitrary project key into a filesystem-safe slug.
 * Any character outside `[A-Za-z0-9._-]` becomes `_`; this neutralizes
 * path separators (`/`, `\`) and traversal (`..` → `__`) so the result
 * always stays a single path segment inside the cache dir.
 */
function sanitizeKey(projectKey: string): string {
  const cleaned = projectKey.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'default';
}
