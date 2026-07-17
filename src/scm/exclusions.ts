/**
 * Central staging-exclusion list — the §4.4 "Exclusion invariant" of the
 * pluggable-SCM design spec
 * (`docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`).
 *
 * Every backend (`git-adapter.ts`, `perforce-adapter.ts`, `none-adapter.ts`)
 * consults this module for `stage` and `changed-files` so the "never stage the
 * planning artifacts / `.gitignore` / `data/*.db` / `.env` / `/bin` / adapter
 * runtime state" rule is enforced in ONE place, in code — not restated per
 * skill.
 *
 * Two consumption modes, per §4.4:
 *   - `changed-files` FILTERS excluded paths out silently → {@link filterExcluded}.
 *   - `stage` REJECTS the whole call when any excluded path is present
 *     (exit 2, listing the offenders) rather than silently dropping them —
 *     a skill that tries to stage `LOOP-RUN.md` has a bug worth surfacing.
 *     → {@link enforceStageExclusions}.
 *
 * All matching runs on **normalized repo-relative paths** (§4.1) so path games
 * (`./x`, `a/../x`, absolute `/x`, backslashes) cannot dodge the check.
 */

import { posix } from 'node:path';
import { ScmError } from './types.js';

// ---------------------------------------------------------------------------
// Normalization (§4.1 "Paths are normalized before the exclusion check")
// ---------------------------------------------------------------------------

/**
 * Reduce an input path to a canonical, forward-slash, repo-root-relative form:
 *   - backslashes → forward slashes,
 *   - leading slashes stripped (an absolute path is anchored at the repo root,
 *     so `/bin/x` and `bin/x` collapse to the same thing — absolute paths
 *     cannot bypass a repo-root-anchored rule),
 *   - `.` / `..` segments and redundant `./` resolved via posix normalization,
 *   - trailing slashes removed.
 *
 * `a/../foo` → `foo`; `./.tasks/.scm/x` → `.tasks/.scm/x`; `/bin/` → `bin`.
 * A path that normalizes to escape the root keeps its leading `../` (it will
 * not match any exclusion rule — outside-root rejection is a separate §4.1
 * invariant owned by the CLI dispatcher, not this module).
 */
export function normalizeRepoRelative(inputPath: string): string {
  const forward = inputPath.replace(/\\/g, '/').trim();
  const anchored = forward.replace(/^\/+/, '');
  let normalized = posix.normalize(anchored);
  normalized = normalized.replace(/\/+$/, '');
  if (normalized === '.' || normalized === '') {
    return '';
  }
  return normalized;
}

function basename(normalizedPath: string): string {
  const idx = normalizedPath.lastIndexOf('/');
  return idx === -1 ? normalizedPath : normalizedPath.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// Exclusion rules (§4.4 list)
// ---------------------------------------------------------------------------

/** One entry in the central exclusion list. `matches` receives a normalized repo-relative path. */
export interface ExclusionRule {
  /** Stable identifier for diagnostics / tests. */
  readonly id: string;
  /** Human-readable reason, surfaced when a `stage` call is rejected. */
  readonly description: string;
  /** True when `normalizedPath` is covered by this rule. */
  matches(normalizedPath: string): boolean;
}

/** Named `.planning/` run artifacts that must never be staged (§4.4). */
export const PLANNING_ARTIFACT_NAMES = ['LOOP-RUN.md', 'AUDIT.md', 'DECOMPOSITION.md'] as const;

/**
 * The central exclusion list (§4.4). Order is not significant — a path is
 * excluded if ANY rule matches.
 */
export const EXCLUSION_RULES: readonly ExclusionRule[] = [
  {
    id: 'adapter-runtime-state',
    description: 'adapter runtime state under .tasks/.scm/ is never staged (§3.1, §4.4)',
    matches: (p) => p === '.tasks/.scm' || p.startsWith('.tasks/.scm/'),
  },
  {
    id: 'planning-artifacts',
    description:
      'planning run artifacts (LOOP-RUN.md, AUDIT.md, DECOMPOSITION.md) are never staged (§4.4)',
    matches: (p) => (PLANNING_ARTIFACT_NAMES as readonly string[]).includes(basename(p)),
  },
  {
    id: 'gitignore',
    description: '.gitignore is never modified by the adapter (§4.4)',
    matches: (p) => basename(p) === '.gitignore',
  },
  {
    id: 'dotenv',
    description: 'environment files (.env, .env.*) are never committed (§4.4)',
    matches: (p) => {
      const name = basename(p);
      return name === '.env' || name.startsWith('.env.');
    },
  },
  {
    id: 'data-db',
    description: 'database files (data/*.db) are never committed (§4.4)',
    matches: (p) => /^data\/[^/]+\.db$/.test(p),
  },
  {
    id: 'bin-dir',
    description: 'the repo-root /bin directory is never committed (§4.4)',
    matches: (p) => p === 'bin' || p.startsWith('bin/'),
  },
];

// ---------------------------------------------------------------------------
// Predicates / filters (the exact functions the backends call)
// ---------------------------------------------------------------------------

/**
 * True when `repoRelPath` (any input form) resolves to a path on the central
 * exclusion list. Normalizes first so `.tasks/.scm/x`, `./.tasks/.scm/x`,
 * `.tasks/.scm/../.scm/x`, and `/.tasks/.scm/x` all match.
 */
export function isExcluded(repoRelPath: string): boolean {
  const normalized = normalizeRepoRelative(repoRelPath);
  if (normalized === '') {
    return false;
  }
  return EXCLUSION_RULES.some((rule) => rule.matches(normalized));
}

/** The rule that first matched `repoRelPath`, or `undefined` if it is not excluded. */
export function matchingExclusionRule(repoRelPath: string): ExclusionRule | undefined {
  const normalized = normalizeRepoRelative(repoRelPath);
  if (normalized === '') {
    return undefined;
  }
  return EXCLUSION_RULES.find((rule) => rule.matches(normalized));
}

/**
 * Partition `paths` into `kept` (safe to report / stage) and `excluded`
 * (on the §4.4 list). Original input strings are preserved in both buckets so
 * callers can echo exactly what they were handed.
 *
 * This is the filter the `changed-files` verb applies: excluded paths are
 * dropped silently so `changed-files` NEVER reports an excluded path, for any
 * backend.
 */
export function filterExcluded(paths: readonly string[]): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const path of paths) {
    if (isExcluded(path)) {
      excluded.push(path);
    } else {
      kept.push(path);
    }
  }
  return { kept, excluded };
}

/**
 * The guard the `stage` verb applies (§4.4): if ANY requested path is on the
 * exclusion list, the WHOLE call fails — a {@link ScmError} with code
 * `CONFIG_INVALID` (→ exit 2, usage/config error) whose message lists every
 * offender. Nothing is silently dropped; a skill trying to stage an excluded
 * path has a bug worth surfacing.
 *
 * Returns the (unchanged) input list when nothing is excluded, so backends can
 * write `const toStage = enforceStageExclusions(files)`.
 */
export function enforceStageExclusions(paths: readonly string[]): string[] {
  const { excluded } = filterExcluded(paths);
  if (excluded.length > 0) {
    throw new ScmError(
      'CONFIG_INVALID',
      `refusing to stage ${excluded.length} excluded path(s): ${excluded.join(', ')}`,
      'these paths are on the central staging-exclusion list (§4.4) and must never be staged or committed',
    );
  }
  return [...paths];
}
