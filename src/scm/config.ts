/**
 * Loader + validator for `.tasks/scm.json` (spec §3.1).
 *
 * `.tasks/scm.json` is the authoritative, committed declaration of which SCM
 * backend a repo uses. This module reads it from a *given repo root*, validates
 * it with a `.strict()` Zod schema (unknown keys are rejected, `version` must be
 * exactly `1`), and returns the typed {@link ScmConfigFile} — or `null` when the
 * file is simply absent (which the resolver treats as "fall through to
 * auto-detect", §3.2). A file that exists but does NOT parse/validate is a HARD
 * config error: `loadScmConfig` throws `ScmError('CONFIG_INVALID', …)` rather
 * than silently falling through to detection.
 *
 * Repo-root discovery + backend detection live in `detect.ts`; this module only
 * reads/validates a root it is handed, so it has no dependency on the
 * filesystem-marker logic (keeps the module graph one-directional:
 * detect.ts → config.ts).
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md` §3.1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ScmError, type ScmConfigFile } from './types.js';

/** Path of the SCM config relative to a repo root — shared with `detect.ts`. */
export const SCM_CONFIG_RELPATH = join('.tasks', 'scm.json');

/**
 * `.strict()` schema for `.tasks/scm.json` (§3.1). Mirrors {@link ScmConfigFile}:
 * `version` fixed to `1`, `backend` one of the four config values, optional
 * `behaviors` (partial, strict) and `ignore`. Unknown top-level keys are
 * rejected so typos surface as a hard error rather than silently no-op.
 */
const scmConfigSchema = z
  .object({
    version: z.literal(1),
    backend: z.enum(['git', 'perforce', 'none', 'auto']),
    behaviors: z
      .object({
        commit: z.boolean(),
        isolate: z.boolean(),
        publish: z.boolean(),
        openReview: z.boolean(),
        branchPerRun: z.boolean(),
      })
      .partial()
      .strict()
      .refine((behaviors) => behaviors.branchPerRun !== true, {
        message:
          'behaviors.branchPerRun is not yet implemented — v1 rejects it rather than silently no-opping (spec §2.3). Omit it or set it to false.',
        path: ['branchPerRun'],
      })
      .optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Load + validate `.tasks/scm.json` from `repoRoot`.
 *
 * @returns the resolved {@link ScmConfigFile}, or `null` when no file exists.
 * @throws {ScmError} `CONFIG_INVALID` when the file exists but cannot be read,
 *   is not valid JSON, or fails schema validation. It NEVER falls through to
 *   auto-detect on a malformed file (§3.1).
 */
export function loadScmConfig(repoRoot: string): ScmConfigFile | null {
  const path = join(repoRoot, SCM_CONFIG_RELPATH);
  if (!existsSync(path)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ScmError(
      'CONFIG_INVALID',
      `Failed to read ${path}: ${(err as Error).message}`,
      'Ensure .tasks/scm.json is readable.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ScmError(
      'CONFIG_INVALID',
      `${path} is not valid JSON: ${(err as Error).message}`,
      'Fix the JSON syntax in .tasks/scm.json.',
    );
  }

  const result = scmConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScmError(
      'CONFIG_INVALID',
      `${path} failed schema validation: ${result.error.message}`,
      'See spec §3.1 for the allowed shape: { version: 1, backend, behaviors?, ignore? }.',
    );
  }

  // `result.data` is structurally the validated shape; the cast only reconciles
  // Zod's `T | undefined` optionals with the config's `exactOptionalPropertyTypes`
  // `T?` optionals (§3.1 — the runtime value is already validated).
  return result.data as ScmConfigFile;
}
