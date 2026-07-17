/**
 * The `none` SCM backend — no-VCS mode (spec §3.3, §5.5).
 *
 * Unlike the git/perforce backends, `none` spawns **no subprocess**: it is a
 * pure-filesystem adapter. `baseline`/`status`/`changed-files` rest on a
 * **digest manifest** written to `.tasks/.scm/<context>/baseline.json`
 * (per-`context`, so concurrent runs never stomp one shared file). Every
 * mutating verb (`stage`/`record`/`publish`/`open-review`) is a no-op, and
 * `reset-hard` is genuinely unsupported — a digest manifest records content
 * identity, not content, so it cannot restore a tree (§5.5).
 *
 * Consumes the shared contract: implements {@link ScmBackend} from `types.ts`
 * and reuses the central exclusion list (`exclusions.ts`) rather than
 * hand-rolling it. The manifest walk additionally honors `.git/` (if a repo
 * happens to have one while SCM is "none") and the configured `ignore` globs
 * from `.tasks/scm.json` (§3.1).
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`
 * §3.3, §5.5.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { loadScmConfig } from './config.js';
import { resolveBackend } from './detect.js';
import { enforceStageExclusions, filterExcluded, isExcluded } from './exclusions.js';
import {
  ScmError,
  type ScmBackend,
  type ScmBaselineData,
  type ScmBehaviors,
  type ScmChangedFile,
  type ScmChangedFilesData,
  type ScmChangeIdData,
  type ScmDetectData,
  type ScmIsolateData,
  type ScmOpenReviewData,
  type ScmPublishData,
  type ScmRecordData,
  type ScmResetHardData,
  type ScmStageData,
  type ScmStatusData,
  type ScmStatusEntry,
  type ScmTeardownIsolationData,
  type ScmVerbContext,
} from './types.js';

// ---------------------------------------------------------------------------
// Defaults (spec §3.1 ignore default, §3.3 behavior defaults)
// ---------------------------------------------------------------------------

/** none-backend behavior defaults when `.tasks/scm.json` omits `behaviors` (§3.3). */
const NONE_DEFAULT_BEHAVIORS: ScmBehaviors = {
  commit: false,
  isolate: false,
  publish: false,
  openReview: false,
  branchPerRun: false,
};

/** Default `ignore` globs excluded from the baseline manifest (§3.1). */
const DEFAULT_IGNORE: readonly string[] = ['node_modules/', 'dist/', '.git/', '*.log'];

/** Where the per-context digest manifest lives, relative to the repo root (§5.5). */
function manifestRelPath(context: string): string {
  return join('.tasks', '.scm', context, 'baseline.json');
}

// ---------------------------------------------------------------------------
// Manifest shapes (spec §5.5 "Per-file record")
// ---------------------------------------------------------------------------

/** One file's digest record in the baseline manifest (§5.5). */
interface NoneManifestEntry {
  /** Repo-root-relative, forward-slash path. */
  path: string;
  /** Byte size (symlink: byte length of the link-target string). */
  size: number;
  /** `mtimeMs` from `lstat` — powers the size+mtime fast path. */
  mtimeMs: number;
  /** sha256 of the file bytes (symlink: sha256 of the link-target string). */
  sha256: string;
}

/** The on-disk `.tasks/.scm/<context>/baseline.json` document. */
interface NoneManifest {
  version: 1;
  /** `none:<sha256-of-canonical-manifest>` (§5.5). */
  id: string;
  context: string;
  /**
   * The baseline manifest file's own filesystem mtime — sourced from the SAME
   * clock/granularity as the entry `mtimeMs` values so the comparison is exact.
   * Powers git-style **racy-clean** detection: any entry whose recorded
   * `mtimeMs >= capturedAtMs` shared the manifest's write tick and may be
   * rewritten in that same tick, so the size+mtime fast path cannot be trusted
   * for it and it is always re-hashed. Excluded from the identity digest — it is
   * capture metadata, not content identity.
   */
  capturedAtMs: number;
  entries: NoneManifestEntry[];
}

// ---------------------------------------------------------------------------
// gitignore-style glob matching (for the configured `ignore` list)
// ---------------------------------------------------------------------------

/**
 * Match `relPath` (repo-relative, forward-slash) against one gitignore-style
 * `pattern`. Supports the shapes the default list uses:
 *   - trailing-slash dir patterns (`node_modules/`) → match the dir and any
 *     descendant, at any depth when the pattern has no internal slash;
 *   - basename globs (`*.log`) → `*` matches within a path segment;
 *   - anchored patterns (containing an internal slash) → matched from root.
 */
function matchesIgnoreGlob(relPath: string, pattern: string): boolean {
  let pat = pattern.trim();
  if (pat === '') {
    return false;
  }
  const dirOnly = pat.endsWith('/');
  if (dirOnly) {
    pat = pat.slice(0, -1);
  }
  const anchored = pat.startsWith('/') || pat.includes('/');
  if (pat.startsWith('/')) {
    pat = pat.slice(1);
  }

  const segToRegex = (seg: string): string =>
    seg
      .split('')
      .map((ch) => {
        if (ch === '*') {
          return '[^/]*';
        }
        if (ch === '?') {
          return '[^/]';
        }
        return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      })
      .join('');

  if (anchored) {
    const body = pat.split('/').map(segToRegex).join('/');
    const re = new RegExp(`^${body}(?:/.*)?$`);
    return re.test(relPath);
  }

  // Non-anchored: match the pattern against a path segment (gitignore
  // semantics — a bare name matches at any depth).
  const segRe = new RegExp(`^${segToRegex(pat)}$`);
  const parts = relPath.split('/');
  if (dirOnly) {
    // Directory pattern: any ANCESTOR segment matching means the file is inside
    // the ignored dir. (Every part except the last is an ancestor dir.)
    return parts.slice(0, -1).some((p) => segRe.test(p));
  }
  return parts.some((p) => segRe.test(p));
}

/** True when `relPath` is covered by any configured ignore glob or the built-in `.git/` skip. */
function isIgnored(relPath: string, ignore: readonly string[]): boolean {
  if (relPath === '.git' || relPath.startsWith('.git/')) {
    return true;
  }
  return ignore.some((pattern) => matchesIgnoreGlob(relPath, pattern));
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stream a file through sha256 without buffering the whole thing (§5.5 perf). */
function hashFile(absPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

// ---------------------------------------------------------------------------
// Manifest build + canonical digest
// ---------------------------------------------------------------------------

/** Convert an OS-native absolute path to a canonical repo-relative forward-slash form. */
function toPosixRel(root: string, absPath: string): string {
  const rel = relative(root, absPath);
  return sep === '/' ? rel : rel.split(sep).join(posix.sep);
}

/**
 * Walk the tree under `root`, building manifest entries. Excludes the central
 * exclusion list (§4.4), `.tasks/.scm/`, `.git/`, and the configured `ignore`
 * globs. When `prev` supplies a same-path record whose size+mtime match AND the
 * file's mtime is strictly older than `fastPathCutoffMs`, the old sha256 is
 * reused (fast path — no re-hash); a file whose `mtimeMs >= fastPathCutoffMs` is
 * "racily clean" (possibly rewritten in the same mtime tick the baseline was
 * captured) and is always re-hashed even when size+mtime match, so a same-size
 * same-tick edit is never missed. **Symlinks are never followed** — the
 * link-target string is recorded instead.
 *
 * @param fastPathCutoffMs the baseline's `capturedAtMs`; defaults to
 *   `+Infinity` (every file eligible for the fast path) — appropriate for a
 *   fresh `baseline` walk where `prev` is empty and everything is hashed anyway.
 */
async function buildEntries(
  root: string,
  ignore: readonly string[],
  prev: ReadonlyMap<string, NoneManifestEntry>,
  fastPathCutoffMs = Number.POSITIVE_INFINITY,
): Promise<NoneManifestEntry[]> {
  const entries: NoneManifestEntry[] = [];

  async function walk(dirAbs: string): Promise<void> {
    const dirents = await readdir(dirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = join(dirAbs, dirent.name);
      const rel = toPosixRel(root, abs);
      if (rel === '' || isExcluded(rel) || isIgnored(rel, ignore)) {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        const stat = await lstat(abs);
        const target = await readlink(abs);
        entries.push({
          path: rel,
          size: Buffer.byteLength(target),
          mtimeMs: stat.mtimeMs,
          sha256: hashString(target),
        });
        continue;
      }

      if (dirent.isDirectory()) {
        await walk(abs);
        continue;
      }

      if (!dirent.isFile()) {
        continue; // sockets/fifos/devices — not part of a content baseline.
      }

      const stat = await lstat(abs);
      const previous = prev.get(rel);
      if (
        previous !== undefined &&
        previous.size === stat.size &&
        previous.mtimeMs === stat.mtimeMs &&
        stat.mtimeMs < fastPathCutoffMs
      ) {
        entries.push({ ...previous }); // fast path: reuse recorded sha256.
        continue;
      }
      entries.push({
        path: rel,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: await hashFile(abs),
      });
    }
  }

  await walk(root);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Canonical, content-identifying serialization of the manifest — `path`, `size`
 * and `sha256` per entry, sorted by path. `mtimeMs` is deliberately excluded so
 * a mere `touch` (identical bytes) does not churn the manifest id (§5.5
 * fast-path rationale — mtime is an optimization detail, not identity).
 */
function canonicalize(entries: readonly NoneManifestEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })),
  );
}

function manifestId(entries: readonly NoneManifestEntry[]): string {
  return `none:${hashString(canonicalize(entries))}`;
}

/** Resolve the effective `ignore` list for `repo` (config value, else the §3.1 default). */
function resolveIgnore(repo: string): readonly string[] {
  const config = loadScmConfig(repo);
  return config?.ignore ?? DEFAULT_IGNORE;
}

/** Read the recorded manifest for `context`, or `null` when none has been written. */
async function readManifest(repo: string, context: string): Promise<NoneManifest | null> {
  const abs = join(repo, manifestRelPath(context));
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw) as NoneManifest;
}

/** Diff a previous manifest's entries against a freshly-walked set (§5.5 comparison). */
function diffEntries(
  previous: readonly NoneManifestEntry[],
  current: readonly NoneManifestEntry[],
): ScmChangedFile[] {
  const prevByPath = new Map(previous.map((entry) => [entry.path, entry]));
  const currByPath = new Map(current.map((entry) => [entry.path, entry]));
  const changes: ScmChangedFile[] = [];

  for (const entry of current) {
    const before = prevByPath.get(entry.path);
    if (before === undefined) {
      changes.push({ path: entry.path, change: 'added' });
    } else if (before.sha256 !== entry.sha256) {
      changes.push({ path: entry.path, change: 'modified' });
    }
  }
  for (const entry of previous) {
    if (!currByPath.has(entry.path)) {
      changes.push({ path: entry.path, change: 'deleted' });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/**
 * The `none` (no-VCS) backend. Stateless aside from the per-context manifest it
 * reads/writes under `.tasks/.scm/`.
 */
export class NoneBackend implements ScmBackend {
  public readonly name = 'none' as const;

  public async detect(ctx: ScmVerbContext): Promise<ScmDetectData> {
    const config = loadScmConfig(ctx.repo);
    const behaviors: ScmBehaviors = { ...NONE_DEFAULT_BEHAVIORS, ...(config?.behaviors ?? {}) };
    const { source } = resolveBackend(ctx.repo);
    return {
      backend: 'none',
      source,
      behaviors,
      capabilities: { isolation: 'shared' },
    };
  }

  public async baseline(ctx: ScmVerbContext): Promise<ScmBaselineData> {
    const ignore = resolveIgnore(ctx.repo);
    const entries = await buildEntries(ctx.repo, ignore, new Map());
    const id = manifestId(entries);
    const relPath = manifestRelPath(ctx.context);
    const abs = join(ctx.repo, relPath);
    await mkdir(join(ctx.repo, '.tasks', '.scm', ctx.context), { recursive: true });

    // `capturedAtMs` MUST be sourced from the SAME clock/granularity as the file
    // mtimeMs values it will be compared against — using `Date.now()` (ms) vs
    // filesystem mtime (which may round to a coarser or offset tick) let a
    // same-tick, same-size rewrite slip through the fast path. So write the
    // manifest first, stat it for its own filesystem mtime (which, being written
    // AFTER the walk, is >= every entry's mtime), then rewrite with that value
    // baked in. Any file later modified in the same tick as its recorded mtime
    // now satisfies `recorded.mtimeMs >= capturedAtMs` and is re-hashed.
    const write = (capturedAtMs: number): Promise<void> => {
      const manifest: NoneManifest = {
        version: 1,
        id,
        context: ctx.context,
        capturedAtMs,
        entries,
      };
      return writeFile(abs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    };
    await write(0);
    const { mtimeMs: capturedAtMs } = await lstat(abs);
    await write(capturedAtMs);
    return { id, manifestPath: relPath };
  }

  public async status(ctx: ScmVerbContext): Promise<ScmStatusData> {
    const manifest = await readManifest(ctx.repo, ctx.context);
    if (manifest === null) {
      throw new ScmError(
        'CONFIG_INVALID',
        `no none-mode baseline recorded for context "${ctx.context}"`,
        'Run `scm baseline --context <id>` before `status`.',
      );
    }
    const ignore = resolveIgnore(ctx.repo);
    const prev = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const current = await buildEntries(ctx.repo, ignore, prev, manifest.capturedAtMs);
    const changes = diffEntries(manifest.entries, current);
    const entries: ScmStatusEntry[] = changes
      .filter((change) => !isExcluded(change.path))
      .map((change) => ({ path: change.path, state: change.change }));
    return { dirty: entries.length > 0, entries };
  }

  public async changedFiles(ctx: ScmVerbContext, base: string): Promise<ScmChangedFilesData> {
    const manifest = await readManifest(ctx.repo, ctx.context);
    if (manifest === null) {
      throw new ScmError(
        'CONFIG_INVALID',
        `no none-mode baseline recorded for context "${ctx.context}"`,
        'Run `scm baseline --context <id>` before `changed-files`.',
      );
    }
    const ignore = resolveIgnore(ctx.repo);
    const prev = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const current = await buildEntries(ctx.repo, ignore, prev, manifest.capturedAtMs);
    const changes = diffEntries(manifest.entries, current);
    const { kept } = filterExcluded(changes.map((change) => change.path));
    const keptSet = new Set(kept);
    const files = changes.filter((change) => keptSet.has(change.path));
    return { base, files };
  }

  public async stage(_ctx: ScmVerbContext, files: string[]): Promise<ScmStageData> {
    // Surface bugs (a caller trying to stage an excluded path throws, exit 2),
    // then no-op: none-mode has no staging area, so nothing is actually staged.
    enforceStageExclusions(files);
    return { staged: [] };
  }

  public async record(_ctx: ScmVerbContext, _message: string): Promise<ScmRecordData> {
    return { recorded: false, changeId: null, mode: 'noop' };
  }

  public async changeId(_ctx: ScmVerbContext): Promise<ScmChangeIdData> {
    // none-mode has no change identifiers — empty array, exit 0 at the CLI layer.
    return { ids: [] };
  }

  public async publish(_ctx: ScmVerbContext): Promise<ScmPublishData> {
    return { published: false, changeId: null };
  }

  public async openReview(_ctx: ScmVerbContext): Promise<ScmOpenReviewData> {
    return { opened: false, url: null };
  }

  public async isolate(_ctx: ScmVerbContext, _id: string): Promise<ScmIsolateData> {
    return { strategy: 'shared' };
  }

  public async teardownIsolation(
    _ctx: ScmVerbContext,
    _id: string,
  ): Promise<ScmTeardownIsolationData> {
    return { tornDown: true };
  }

  public async resetHard(_ctx: ScmVerbContext, _ref: string): Promise<ScmResetHardData> {
    // A digest manifest records identity, not content — it cannot restore a
    // tree, so `reset-hard` is genuinely unsupported in none-mode (§5.5 → exit 4).
    throw new ScmError(
      'UNSUPPORTED_VERB',
      'reset-hard is unsupported in none-mode: the digest manifest cannot restore content',
      'none-mode recovery is manual; use git or perforce for restorable checkpoints.',
    );
  }
}

/** The singleton none backend instance the CLI dispatcher wires up (task #1536). */
export const noneBackend: ScmBackend = new NoneBackend();
