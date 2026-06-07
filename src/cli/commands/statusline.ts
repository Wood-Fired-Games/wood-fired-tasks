/**
 * `tasks statusline` command (project 29, Phase 4, task #597).
 *
 * Renders the one-line status-line segment Claude Code displays below the
 * prompt. Claude Code pipes its status-line JSON on stdin; we read it, resolve
 * the linked project for the reported `cwd`, serve task counts from a TTL cache
 * (refreshing over REST only when the cache is stale/missing), and append an
 * update-available hint that comes from a PURE READ of the update-check cache.
 *
 * Hard contracts (all judged verbatim by the acceptance criteria):
 *
 *   - ALWAYS exits 0. Empty/garbage stdin, an unreachable API, a missing
 *     cache, a malformed config — none of them crash or change the exit code.
 *   - Prints the composed line and exits 0 when a project is linked and
 *     counts resolve from cache.
 *   - Prints nothing (or only the update hint) and exits 0 when no project is
 *     linked.
 *   - Does NOT call the REST API when the count cache is FRESH.
 *   - Degrades to stale-or-blank (no error, exit 0) when the API is
 *     unreachable on a refresh.
 *   - Appends the update hint ONLY when the update-check cache says one is
 *     available AND {@link isUpdateCheckEnabled} is true. The render path does
 *     NO network for the hint — it is a pure cache read.
 *   - The counts segment and the update-hint segment degrade INDEPENDENTLY: a
 *     failure in one never suppresses the other.
 *
 * Every external dependency (stdin, the resolver, the fetcher, both caches, the
 * project-name lookup, the enablement check, and the clock) is injectable via
 * {@link StatuslineDeps} so the command can be exercised in-process without a
 * live server. The full subprocess test is task #599; this command's own test
 * uses the injected seams.
 */
import { Command } from 'commander';

import {
  type CountCache,
  type TtlResult,
  readCountCache,
  readUpdateCache,
  writeCountCache,
} from '../cache/count-cache.js';
import { isUpdateCheckEnabled } from '../config/update-check.js';
import { type CountResult, fetchCounts } from '../statusline/count-fetcher.js';
import { type ProjectResolution, resolveProjectFromCwd } from '../statusline/resolve-project.js';
import { formatStatuslineSegment } from '../statusline/format-segment.js';

/**
 * TTL for the per-project count cache. A status line re-renders on nearly
 * every keystroke/turn, so a short TTL keeps the displayed counts reasonably
 * live while still avoiding a REST round-trip on the vast majority of renders.
 */
const COUNT_CACHE_TTL_MS = 30_000;

/**
 * TTL for reading the update-available cache. The render path NEVER writes or
 * refreshes this cache (that's the #795 writer's job); a generous TTL just
 * means a stale-but-present hint is treated as `missing` rather than shown
 * indefinitely after the writer stops running.
 */
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Subset of Claude Code's status-line JSON we look at. Everything optional. */
interface StatuslineInput {
  /** The working directory Claude Code reports for the current session. */
  cwd?: unknown;
  /** Alternative key some harness versions use; checked as a fallback. */
  workspace?: { current_dir?: unknown } | undefined;
}

/** Injectable seams. Defaults wire to the real modules. */
export interface StatuslineDeps {
  /** Reads the status-line JSON from stdin (to EOF). */
  readStdin?: () => Promise<string>;
  /** Resolves a project from the reported cwd (#593). */
  resolveProject?: (cwd: string) => Promise<ProjectResolution>;
  /** Fetches `{ open, doneClosed }` counts over REST (#594). */
  fetchCounts?: (projectId: number) => Promise<CountResult>;
  /** Resolves a display name for a numeric project id (best-effort). */
  resolveProjectName?: (projectId: number) => Promise<string | undefined>;
  /** Reads the per-project count cache (#592). */
  readCountCache?: (projectKey: string, ttlMs: number, now?: number) => TtlResult<CountCache>;
  /** Writes the per-project count cache (#592). */
  writeCountCache?: (
    projectKey: string,
    payload: Omit<CountCache, 'fetchedAt'>,
    now?: number,
  ) => CountCache;
  /** Reads the update-available cache (#592). */
  readUpdateCache?: (ttlMs: number, now?: number) => TtlResult<{ updateAvailable: boolean }>;
  /** Whether the update-available feature is enabled (#797). */
  isUpdateCheckEnabled?: () => boolean;
  /** Injectable clock for deterministic TTL math. */
  now?: () => number;
}

/** Resolve the cwd to use, preferring the stdin JSON over `process.cwd()`. */
function resolveCwd(input: StatuslineInput | undefined): string {
  const fromCwd = input?.cwd;
  if (typeof fromCwd === 'string' && fromCwd.length > 0) return fromCwd;
  const fromWorkspace = input?.workspace?.current_dir;
  if (typeof fromWorkspace === 'string' && fromWorkspace.length > 0) return fromWorkspace;
  return process.cwd();
}

/** Parse the stdin blob into a {@link StatuslineInput}; never throws. */
function parseInput(raw: string): StatuslineInput | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as StatuslineInput;
  } catch {
    // Garbage stdin is tolerated — fall back to process.cwd().
  }
  return undefined;
}

/** Read all of stdin to a string. Resolves '' if stdin is a TTY / empty. */
function defaultReadStdin(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // A TTY with no piped input would hang forever; treat as empty.
    if (stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
  });
}

/** Lazy project-name lookup so the API module isn't imported until needed. */
async function defaultResolveProjectName(projectId: number): Promise<string | undefined> {
  try {
    const { getProject } = await import('../api/client.js');
    const project = await getProject(projectId);
    return typeof project.name === 'string' ? project.name : undefined;
  } catch {
    return undefined;
  }
}

/** Stable cache key for a resolution: numeric id wins, else the repo name. */
function cacheKeyFor(resolution: { projectId?: number; repoName?: string }): string | undefined {
  if (resolution.projectId !== undefined) return String(resolution.projectId);
  if (resolution.repoName !== undefined && resolution.repoName.length > 0) {
    return resolution.repoName;
  }
  return undefined;
}

/** A counts segment ready to hand to the formatter, or undefined to omit it. */
interface CountsSegment {
  projectName: string;
  open: number;
  doneClosed: number;
}

/**
 * Resolve the counts segment for a linked project. Tries the cache first
 * (no API call when FRESH); on stale/missing it refreshes over REST and, on
 * success, writes the cache. Any failure degrades to the stale cache value if
 * one exists, else to `undefined` (omit the segment). NEVER throws.
 */
async function resolveCountsSegment(
  resolution: ProjectResolution,
  deps: Required<
    Pick<
      StatuslineDeps,
      'fetchCounts' | 'resolveProjectName' | 'readCountCache' | 'writeCountCache' | 'now'
    >
  >,
): Promise<CountsSegment | undefined> {
  if (!resolution.resolved) return undefined;

  const key = cacheKeyFor(resolution);
  // No usable key and no numeric id → nothing to fetch or cache.
  if (key === undefined) return undefined;

  const now = deps.now();

  let cached: TtlResult<CountCache>;
  try {
    cached = deps.readCountCache(key, COUNT_CACHE_TTL_MS, now);
  } catch {
    cached = { state: 'missing' };
  }

  // FRESH cache → render from it with NO API call.
  if (cached.state === 'fresh') {
    return {
      projectName: cached.value.projectName,
      open: cached.value.open,
      doneClosed: cached.value.doneClosed,
    };
  }

  // We can only refresh when we have a numeric id to query.
  if (resolution.projectId === undefined) {
    // Stale-or-blank: no id to refresh with, fall back to a stale value.
    return cached.state === 'stale'
      ? {
          projectName: cached.value.projectName,
          open: cached.value.open,
          doneClosed: cached.value.doneClosed,
        }
      : undefined;
  }

  // STALE or MISSING → refresh over REST (counts + name, concurrently).
  let counts: CountResult;
  try {
    counts = await deps.fetchCounts(resolution.projectId);
  } catch {
    counts = { ok: false, error: 'fetch threw' };
  }

  if (!counts.ok) {
    // API unreachable → degrade to the stale value when present, else blank.
    return cached.state === 'stale'
      ? {
          projectName: cached.value.projectName,
          open: cached.value.open,
          doneClosed: cached.value.doneClosed,
        }
      : undefined;
  }

  // Counts succeeded. Resolve a display name: prefer a freshly fetched name,
  // then the stale cache's name, then the resolution's repoName, then `#id`.
  let projectName: string | undefined;
  try {
    projectName = await deps.resolveProjectName(resolution.projectId);
  } catch {
    projectName = undefined;
  }
  if (projectName === undefined && cached.state === 'stale') {
    projectName = cached.value.projectName;
  }
  if (projectName === undefined) projectName = resolution.repoName;
  if (projectName === undefined) projectName = `#${resolution.projectId}`;

  // Persist the refreshed entry (best-effort — a write failure must not crash).
  try {
    deps.writeCountCache(
      key,
      {
        projectId: resolution.projectId,
        projectName,
        open: counts.open,
        doneClosed: counts.doneClosed,
      },
      now,
    );
  } catch {
    // Ignore — we still render the freshly fetched counts below.
  }

  return { projectName, open: counts.open, doneClosed: counts.doneClosed };
}

/**
 * Resolve whether to show the update hint. PURE cache read — no network. The
 * hint shows only when the feature is enabled AND the cache says an update is
 * available. Any failure degrades to "no hint". NEVER throws.
 */
function resolveUpdateHint(
  deps: Required<Pick<StatuslineDeps, 'readUpdateCache' | 'isUpdateCheckEnabled' | 'now'>>,
): boolean {
  try {
    if (!deps.isUpdateCheckEnabled()) return false;
  } catch {
    return false;
  }

  try {
    const result = deps.readUpdateCache(UPDATE_CACHE_TTL_MS, deps.now());
    if (result.state === 'fresh' || result.state === 'stale') {
      return result.value.updateAvailable === true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Resolve `--no-color` / `NO_COLOR` into the formatter's `color` override. */
function resolveColor(noColorFlag: boolean): boolean | undefined {
  // `--no-color` (Commander negates to `color === false`) or NO_COLOR env
  // forces plain output. Otherwise let the formatter decide (return undefined).
  if (noColorFlag) return false;
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  return undefined;
}

/**
 * Core render. Returns the composed one-line segment (possibly empty). Pure
 * orchestration over the injected seams; the Commander action is a thin shell
 * that wires defaults, calls this, writes stdout, and forces exit 0.
 */
export async function renderStatusline(
  deps: StatuslineDeps = {},
  color?: boolean | undefined,
): Promise<string> {
  const resolved: Required<StatuslineDeps> = {
    readStdin: deps.readStdin ?? defaultReadStdin,
    resolveProject: deps.resolveProject ?? resolveProjectFromCwd,
    fetchCounts: deps.fetchCounts ?? fetchCounts,
    resolveProjectName: deps.resolveProjectName ?? defaultResolveProjectName,
    readCountCache: deps.readCountCache ?? readCountCache,
    writeCountCache: deps.writeCountCache ?? writeCountCache,
    readUpdateCache: deps.readUpdateCache ?? readUpdateCache,
    isUpdateCheckEnabled: deps.isUpdateCheckEnabled ?? isUpdateCheckEnabled,
    now: deps.now ?? Date.now,
  };

  // ── stdin → cwd ──────────────────────────────────────────────────────────
  let raw = '';
  try {
    raw = await resolved.readStdin();
  } catch {
    raw = '';
  }
  const input = parseInput(raw);
  const cwd = resolveCwd(input);

  // ── resolve the linked project (never throws per #593 contract) ──────────
  let resolution: ProjectResolution;
  try {
    resolution = await resolved.resolveProject(cwd);
  } catch {
    resolution = { resolved: false };
  }

  // ── counts + update hint degrade INDEPENDENTLY ───────────────────────────
  const counts = await resolveCountsSegment(resolution, resolved);
  const updateAvailable = resolveUpdateHint(resolved);

  return formatStatuslineSegment({
    counts,
    updateAvailable,
    color,
  });
}

export const statuslineCommand = new Command('statusline')
  .description('Render the Claude Code status-line segment (reads status-line JSON on stdin)')
  // Commander auto-adds `--no-color` as the negation of a `--color` option.
  .option('--no-color', 'Disable ANSI color in the rendered segment')
  .action(async () => {
    // `--no-color` makes Commander set `color: false`; default is `color: true`.
    const opts = statuslineCommand.opts() as { color?: boolean };
    const noColorFlag = opts.color === false;
    const color = resolveColor(noColorFlag);

    let line = '';
    try {
      line = await renderStatusline({}, color);
    } catch {
      // Belt-and-suspenders: renderStatusline already swallows everything, but
      // the command must NEVER crash or change the exit code.
      line = '';
    }

    if (line.length > 0) {
      process.stdout.write(line + '\n');
    }
    // ALWAYS exit 0.
    process.exitCode = 0;
  });
