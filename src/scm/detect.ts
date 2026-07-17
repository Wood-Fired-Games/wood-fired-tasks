/**
 * Repo-root discovery + SCM backend auto-detection + backend resolution
 * (spec §3.2).
 *
 * - {@link findRepoRoot}: walk up from a start dir to the nearest ancestor that
 *   holds `.tasks/scm.json` (authoritative), else the nearest ancestor with an
 *   SCM marker (`.git/`, perforce). Shared with `config.ts` via the
 *   {@link SCM_CONFIG_RELPATH} constant re-exported from that module.
 * - {@link detectBackend}: pure filesystem-marker detection per §3.2(3) —
 *   `.git/` → `git`; `.p4config`/`$P4CONFIG`/`.p4` → `perforce`; else `none`.
 * - {@link resolveBackend}: the resolution precedence — a present
 *   `.tasks/scm.json` with a concrete `backend` OVERRIDES detection; a missing
 *   file or `backend: "auto"` triggers detection. (The project-charter tier of
 *   §3.2 is OUT OF SCOPE here and handled by another task.)
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md` §3.2.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SCM_CONFIG_RELPATH, loadScmConfig } from './config.js';
import type { ScmBackendName } from './types.js';

/**
 * True when `dir` contains a Perforce marker (§3.2(3)): a `.p4config` or `.p4`
 * file, or a file named by `$P4CONFIG` (Perforce's per-directory config-file
 * convention).
 */
function hasPerforceMarker(dir: string): boolean {
  if (existsSync(join(dir, '.p4config')) || existsSync(join(dir, '.p4'))) {
    return true;
  }
  const p4config = process.env['P4CONFIG'];
  return p4config !== undefined && p4config !== '' && existsSync(join(dir, p4config));
}

/** True when `dir` holds any SCM marker used as a repo-root fallback (§3.2). */
function hasScmMarker(dir: string): boolean {
  return existsSync(join(dir, '.git')) || hasPerforceMarker(dir);
}

/**
 * Resolve the repo root for `startDir` (§3.2): walk up to the nearest ancestor
 * that contains `.tasks/scm.json` (authoritative); failing that, walk up to the
 * nearest ancestor with an SCM marker (`.git/` or a Perforce marker). If
 * neither is found, the resolved (absolute) `startDir` is returned so callers
 * always get a usable root.
 */
export function findRepoRoot(startDir: string): string {
  const start = resolve(startDir);

  // Pass 1: nearest ancestor with .tasks/scm.json — authoritative (§3.2(1)).
  for (let dir = start; ; ) {
    if (existsSync(join(dir, SCM_CONFIG_RELPATH))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  // Pass 2: nearest ancestor with an SCM marker (§3.2(3) root fallback).
  for (let dir = start; ; ) {
    if (hasScmMarker(dir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return start;
}

/**
 * Auto-detect the backend at `root` from filesystem markers (§3.2(3)):
 * `.git/` present → `git`; a Perforce marker present → `perforce`; otherwise
 * `none`. `git` is checked first so a repo with both markers resolves to git.
 */
export function detectBackend(root: string): ScmBackendName {
  const dir = resolve(root);
  if (existsSync(join(dir, '.git'))) {
    return 'git';
  }
  if (hasPerforceMarker(dir)) {
    return 'perforce';
  }
  return 'none';
}

/** Where a resolved backend came from — the config file or auto-detection. */
export type ScmBackendSource = 'file' | 'auto';

export interface ResolvedScmBackend {
  backend: ScmBackendName;
  source: ScmBackendSource;
}

/**
 * Resolve the effective backend for `root` (§3.2 precedence):
 *
 * 1. A present `.tasks/scm.json` with a concrete `backend`
 *    (`git`/`perforce`/`none`) is authoritative and OVERRIDES detection
 *    (`source: 'file'`).
 * 2. A missing config, or a config with `backend: "auto"`, triggers
 *    {@link detectBackend} (`source: 'auto'`).
 *
 * An invalid config surfaces as the `ScmError('CONFIG_INVALID')` thrown by
 * {@link loadScmConfig} — it never silently falls through to detection.
 *
 * @throws {ScmError} `CONFIG_INVALID` (propagated from {@link loadScmConfig}).
 */
export function resolveBackend(root: string): ResolvedScmBackend {
  const config = loadScmConfig(root);
  if (config !== null && config.backend !== 'auto') {
    return { backend: config.backend, source: 'file' };
  }
  return { backend: detectBackend(root), source: 'auto' };
}
