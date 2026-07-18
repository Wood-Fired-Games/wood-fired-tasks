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
 *   file or `backend: "auto"` triggers detection; failing that (no config,
 *   no detectable marker), the project charter's `scm.backend` hint (§3.2
 *   tier 2, hardening spec §2.2) is used as a default-only fallback
 *   (`source: 'charter'`). When the charter names a backend a detected
 *   marker CONTRADICTS, the marker wins and a conflict warning is recorded
 *   on the result (task #1550).
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md` §3.2,
 * `docs/superpowers/specs/2026-07-17-pluggable-scm-hardening.md` §2.2.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ScmCharter } from '../schemas/scm-charter.schema.js';
import { SCM_CONFIG_RELPATH, loadScmConfig } from './config.js';
import { ScmError, type ScmBackendName } from './types.js';

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
 * `none`.
 *
 * When BOTH a `.git` marker and a Perforce marker are present at `root`,
 * auto-detect is ambiguous and refuses rather than guessing (parent spec
 * §3.2: "guessing here is how a submit ends up in the wrong system") — it
 * throws `ScmError('CONFIG_INVALID')` demanding an explicit
 * `.tasks/scm.json`. This only fires when both markers sit at the SAME
 * resolved root; a marker found only in an ancestor (e.g. via
 * {@link findRepoRoot}'s walk-up) never reaches this function.
 *
 * @throws {ScmError} `CONFIG_INVALID` when both `.git` and a Perforce marker
 *   are present at `root`.
 */
export function detectBackend(root: string): ScmBackendName {
  const dir = resolve(root);
  const hasGit = existsSync(join(dir, '.git'));
  const hasPerforce = hasPerforceMarker(dir);

  if (hasGit && hasPerforce) {
    throw new ScmError(
      'CONFIG_INVALID',
      `Ambiguous SCM markers at ${dir}: both .git and a Perforce marker (.p4config/.p4/$P4CONFIG) are present.`,
      'Auto-detect refuses to guess. Add an explicit .tasks/scm.json with a concrete "backend" (git|perforce|none).',
    );
  }
  if (hasGit) {
    return 'git';
  }
  if (hasPerforce) {
    return 'perforce';
  }
  return 'none';
}

/** Where a resolved backend came from — the config file, auto-detection, or the project charter's default-only hint. */
export type ScmBackendSource = 'file' | 'auto' | 'charter';

export interface ResolvedScmBackend {
  backend: ScmBackendName;
  source: ScmBackendSource;
  /**
   * Non-fatal resolution notices — currently just the charter/marker
   * conflict case (§2.2). Omitted (not an empty array) when there is
   * nothing to report. Plumbing this into the CLI's `warnings[]` envelope
   * is a later task (#1552); callers that only need the resolved backend
   * can ignore this field.
   */
  warnings?: string[];
}

/**
 * Extract a *concrete* backend hint from a project charter's `scm` object
 * (hardening spec §2.2): `undefined` (no `backend` key) and `'auto'` both
 * mean "no hint" — a charter can't defer to itself.
 */
function charterBackendHint(charterScm: ScmCharter | null | undefined): ScmBackendName | undefined {
  const backend = charterScm?.backend;
  if (backend === undefined || backend === 'auto') {
    return undefined;
  }
  return backend;
}

/**
 * Resolve the effective backend for `root` (§3.2 precedence, extended by
 * hardening spec §2.2):
 *
 * 1. A present `.tasks/scm.json` with a concrete `backend`
 *    (`git`/`perforce`/`none`) is authoritative and OVERRIDES detection
 *    (`source: 'file'`).
 * 2. A missing config, or a config with `backend: "auto"`, triggers
 *    {@link detectBackend}. A detected marker (`git`/`perforce`) wins
 *    (`source: 'auto'`) — if a concrete `charterScm.backend` hint is also
 *    supplied and CONTRADICTS the marker, the marker still wins but a
 *    conflict warning is recorded on the result.
 * 3. When detection finds no marker (`detectBackend` returns `'none'`) and a
 *    concrete `charterScm.backend` hint is supplied, that hint is used as a
 *    default-only fallback (`source: 'charter'`).
 * 4. Otherwise, `'none'`/`'auto'` (the pre-charter baseline).
 *
 * An invalid config surfaces as the `ScmError('CONFIG_INVALID')` thrown by
 * {@link loadScmConfig} — it never silently falls through to detection.
 *
 * @param charterScm the project charter's `scm` default (already fetched by
 *   the caller — this function makes no DB round-trip), or `undefined`/`null`
 *   when the caller has none to offer.
 * @throws {ScmError} `CONFIG_INVALID` (propagated from {@link loadScmConfig}
 *   or {@link detectBackend}'s ambiguous dual-marker refusal).
 */
export function resolveBackend(root: string, charterScm?: ScmCharter | null): ResolvedScmBackend {
  const config = loadScmConfig(root);
  if (config !== null && config.backend !== 'auto') {
    return { backend: config.backend, source: 'file' };
  }

  const detected = detectBackend(root);
  const charterBackend = charterBackendHint(charterScm);

  if (detected !== 'none') {
    if (charterBackend !== undefined && charterBackend !== detected) {
      return {
        backend: detected,
        source: 'auto',
        warnings: [
          `Project charter scm.backend hint ("${charterBackend}") conflicts with the on-disk marker ("${detected}"); the on-disk marker wins.`,
        ],
      };
    }
    return { backend: detected, source: 'auto' };
  }

  if (charterBackend !== undefined) {
    return { backend: charterBackend, source: 'charter' };
  }

  return { backend: 'none', source: 'auto' };
}
