/**
 * Working-dir → project resolver (project 29, task #593).
 *
 * Maps a current working directory to a wood-fired-tasks project for the
 * status-line's linked-project counts segment (#594/#596). The resolution is
 * vendor-neutral — no harness-specific (GSD/bugs/Claude) naming leaks into the
 * public surface; the only on-disk inputs are a generic `.planning/config.json`
 * (an integration manifest that *may* carry a mirrored project id) and a
 * repo-local `.wft/project` marker.
 *
 * Precedence (first match wins):
 *   1. Walk UP from `cwd` for `.planning/config.json`; if it parses and exposes
 *      `integrations.bugs_mirror.project_id`, use that → `source: 'bugs_mirror'`.
 *   2. Else read a `.wft/project` marker file (repo-local, walked up the same
 *      way) for the project id or name → `source: 'wft_marker'`.
 *   3. Else derive a repo-name candidate (the cwd basename) and match it
 *      against the API project list → `source: 'repo_name'`.
 *   4. Else `{ resolved: false }` (unlinked).
 *
 * NEVER throws. Every I/O / parse / network failure degrades to the next
 * precedence rung and ultimately to the `unlinked` result, so a status-line
 * render can always proceed.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProjectResponse } from '../api/types.js';

/** How a project was resolved from the working directory. */
export type ResolveSource = 'bugs_mirror' | 'wft_marker' | 'repo_name';

/** A successful resolution. At least one of `projectId` / `repoName` is set. */
export interface ResolvedProject {
  resolved: true;
  source: ResolveSource;
  /** Numeric project id, when known (always set for `bugs_mirror`). */
  projectId?: number;
  /** Repo / project name candidate, when known. */
  repoName?: string;
}

/** No project could be linked to the working directory. */
export interface UnlinkedProject {
  resolved: false;
}

/** Discriminated result of {@link resolveProjectFromCwd}. */
export type ProjectResolution = ResolvedProject | UnlinkedProject;

/** Injectable dependencies (defaults wired to real fs + API client). */
export interface ResolveOptions {
  /**
   * Lists projects for the repo-name fallback. Injected for testability; the
   * default lazily imports the real API client so module load stays cheap and
   * offline status-line renders never trigger a network import.
   */
  listProjects?: () => Promise<ProjectResponse[]>;
  /**
   * Max directories to walk upward looking for `.planning/config.json` /
   * `.wft/project`. Guards against pathological paths; defaults to 64.
   */
  maxDepth?: number;
}

const UNLINKED: UnlinkedProject = { resolved: false };

/**
 * Resolve the project linked to `cwd`. Never throws; returns a discriminated
 * union. See module docs for the precedence rules.
 */
export async function resolveProjectFromCwd(
  cwd: string,
  opts: ResolveOptions = {},
): Promise<ProjectResolution> {
  const maxDepth = opts.maxDepth ?? 64;

  // ── Rung 1 + 2: walk up once, checking both markers per directory. ──
  // We walk a single ancestry chain and, at each level, prefer the
  // `.planning/config.json` bugs_mirror id, then the `.wft/project` marker.
  // The FIRST directory that yields either wins, matching "nearest marker".
  for (const dir of ancestors(cwd, maxDepth)) {
    const fromConfig = readBugsMirrorProjectId(join(dir, '.planning', 'config.json'));
    if (fromConfig !== undefined) {
      return { resolved: true, source: 'bugs_mirror', projectId: fromConfig };
    }

    const fromMarker = readWftMarker(join(dir, '.wft', 'project'));
    if (fromMarker) {
      return { resolved: true, source: 'wft_marker', ...fromMarker };
    }
  }

  // ── Rung 3: API repo-name fallback. ──
  const repoName = basename(cwd);
  if (repoName) {
    const match = await matchRepoName(repoName, opts.listProjects);
    if (match) {
      return { resolved: true, source: 'repo_name', projectId: match.id, repoName };
    }
  }

  // ── Rung 4: unlinked. ──
  return UNLINKED;
}

/** Yield `cwd` and each parent directory, up to `maxDepth` levels. */
function* ancestors(cwd: string, maxDepth: number): Generator<string> {
  let dir = cwd;
  for (let i = 0; i < maxDepth; i++) {
    yield dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
}

/**
 * Read `integrations.bugs_mirror.project_id` from a `.planning/config.json`.
 * Returns a positive integer project id, or `undefined` if the file is
 * missing, unreadable, not JSON, or lacks a usable id. Never throws.
 */
function readBugsMirrorProjectId(configPath: string): number | undefined {
  const raw = safeRead(configPath);
  if (raw === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const id = (parsed as Record<string, unknown> | null)?.['integrations'];
  const bugsMirror = (id as Record<string, unknown> | undefined)?.['bugs_mirror'];
  const projectId = (bugsMirror as Record<string, unknown> | undefined)?.['project_id'];

  return coerceProjectId(projectId);
}

/**
 * Read a `.wft/project` marker. Accepts either a bare numeric id or a project
 * name (first non-empty, non-comment line). Returns the parsed fields, or
 * `undefined` when the marker is absent or empty. Never throws.
 */
function readWftMarker(markerPath: string): { projectId?: number; repoName?: string } | undefined {
  const raw = safeRead(markerPath);
  if (raw === undefined) return undefined;

  // First non-empty, non-comment line is the payload.
  const line = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#'));

  if (!line) return undefined;

  const asId = coerceProjectId(line);
  if (asId !== undefined) return { projectId: asId };
  return { repoName: line };
}

/**
 * Match a repo-name candidate against the API project list (case-insensitive,
 * exact name match). Returns the matched project, or `undefined` on no match,
 * empty list, or any network/parse failure. Never throws.
 */
async function matchRepoName(
  repoName: string,
  inject?: () => Promise<ProjectResponse[]>,
): Promise<ProjectResponse | undefined> {
  let projects: ProjectResponse[];
  try {
    const lister = inject ?? defaultListProjects;
    projects = await lister();
  } catch {
    return undefined;
  }

  const needle = repoName.toLowerCase();
  return projects.find((p) => typeof p.name === 'string' && p.name.toLowerCase() === needle);
}

/** Lazy real-client lister so the API module isn't imported until needed. */
async function defaultListProjects(): Promise<ProjectResponse[]> {
  const { listProjects } = await import('../api/client.js');
  return listProjects();
}

/** `readFileSync` that returns `undefined` instead of throwing on any error. */
function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Coerce an unknown value (number or numeric string) into a positive integer
 * project id. Returns `undefined` for anything else (null, 0, negatives,
 * non-integers, non-numeric strings).
 */
function coerceProjectId(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number(trimmed);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }
  return undefined;
}
