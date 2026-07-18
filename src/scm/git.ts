/**
 * `git.ts` — the git {@link ScmBackend} implementation (spec §4 verb table).
 *
 * Every git invocation routes through {@link execScm} (the §6.1-hardened
 * subprocess wrapper); this module never spawns a child process any other way.
 * Shapes come from `types.ts`; the exclusion invariant (§4.4) is enforced via
 * `exclusions.ts`. Nothing here wires the CLI — the CLI dispatcher (a separate
 * task) wraps each method's resolved `data` / thrown {@link ScmError} into the
 * §4.1 envelope + exit code.
 *
 * Parity requirement (§5.1): git `change-id` / `commit_shas` stay **bare SHAs**,
 * byte-identical to the raw `git rev-parse HEAD` the legacy loop already emits.
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`
 * §3.3 (git behavior defaults), §4 (verb table), §4.1 (data shapes + git edge
 * cases), §4.4 (exclusion invariant), §5.1 (evidence generalization),
 * §5.2 (platform-worktree constraint).
 */

import { loadScmConfig } from './config.js';
import { execScm } from './exec.js';
import type { ExecScmResult } from './exec.js';
import { enforceStageExclusions, filterExcluded } from './exclusions.js';
import {
  ScmError,
  type ScmBackend,
  type ScmBaselineData,
  type ScmBehaviors,
  type ScmChangeIdData,
  type ScmChangedFile,
  type ScmChangedFilesData,
  type ScmDetectData,
  type ScmErrorCode,
  type ScmFileChangeType,
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

/** Git per-backend behavior defaults when `.tasks/scm.json` omits `behaviors` (§3.3). */
export const GIT_DEFAULT_BEHAVIORS: ScmBehaviors = {
  commit: true,
  isolate: true,
  publish: true,
  openReview: false,
  branchPerRun: false,
};

/** Push can be slow (network); §6.1 says submit/push call-sites raise the timeout to 300s. */
const PUSH_TIMEOUT_MS = 300_000;

/**
 * Resolve the effective git behaviors + config source for `repo`: git defaults
 * (§3.3) with any `.tasks/scm.json` `behaviors` overrides layered on top. The
 * `source` mirrors the §3.2 precedence used by `detect.ts` (a concrete
 * `backend` in the file → `"file"`, else auto-detected).
 */
function resolveGitBehaviors(repo: string): { behaviors: ScmBehaviors; source: 'file' | 'auto' } {
  const config = loadScmConfig(repo);
  const behaviors: ScmBehaviors = { ...GIT_DEFAULT_BEHAVIORS, ...(config?.behaviors ?? {}) };
  const source: 'file' | 'auto' = config !== null && config.backend !== 'auto' ? 'file' : 'auto';
  return { behaviors, source };
}

/** Throw a verb-scoped {@link ScmError} for a git command that exited non-zero. */
function failGit(verb: string, res: ExecScmResult, code: ScmErrorCode, hint?: string): never {
  const detail = (res.stderr.trim() || res.stdout.trim() || '(no output)').slice(0, 2000);
  throw new ScmError(code, `git ${verb} failed (exit ${res.code}): ${detail}`, hint);
}

/**
 * Missing-identity git stderr signatures (§6.4): `git commit` refuses to run
 * without a usable `user.email`/`user.name`, and the exact wording differs
 * across git versions/platforms — match the known variants.
 */
const MISSING_IDENTITY_RE =
  /please tell me who you are|unable to auto-detect email address|empty ident name/i;

/**
 * Hook-failure git stderr/stdout signatures (§6.4): a `pre-commit` (or other)
 * hook that exits non-zero aborts the commit before git even looks at the
 * tree state, so this is distinct from a genuine dirty-tree failure.
 */
const HOOK_FAILURE_RE = /pre-commit hook|hook failed|\.git[/\\]hooks[/\\]/i;

/**
 * Map a `git diff --name-status` status letter to the normative
 * {@link ScmFileChangeType} (§4.1). `A` → added, `D` → deleted; every other
 * letter (`M` modified, `R` renamed, `C` copied, `T` typechange, `U` unmerged)
 * collapses to `modified` — the spec's change vocabulary is
 * added/modified/deleted only.
 */
function mapChangeLetter(statusField: string): ScmFileChangeType {
  const letter = statusField.charAt(0).toUpperCase();
  if (letter === 'A') return 'added';
  if (letter === 'D') return 'deleted';
  return 'modified';
}

/**
 * The git backend. One method per §4 verb; all git shell-outs go through
 * {@link execScm}. Stateless — a single instance is safe to share across
 * `--context` values (per-context state lives in the repo, not the object).
 */
export class GitBackend implements ScmBackend {
  public readonly name = 'git' as const;

  /** `detect` (§4.1): resolved git backend + §3.3 behaviors + platform-worktree isolation capability. */
  async detect(ctx: ScmVerbContext): Promise<ScmDetectData> {
    const { behaviors, source } = resolveGitBehaviors(ctx.repo);
    return {
      backend: 'git',
      source,
      behaviors,
      capabilities: { isolation: 'platform-worktree' },
    };
  }

  /** `baseline` (§4): `git rev-parse HEAD` → `{ id: <bare sha> }`. */
  async baseline(ctx: ScmVerbContext): Promise<ScmBaselineData> {
    const res = await execScm('git', ['rev-parse', 'HEAD'], { cwd: ctx.repo });
    if (res.code !== 0) {
      failGit(
        'rev-parse HEAD',
        res,
        'BACKEND_UNAVAILABLE',
        'Repository has no commits yet (unborn HEAD) or is not a git repo.',
      );
    }
    return { id: res.stdout.trim() };
  }

  /** `status` (§4): `git status --porcelain` → `{ dirty, entries }`. */
  async status(ctx: ScmVerbContext): Promise<ScmStatusData> {
    const res = await execScm('git', ['status', '--porcelain'], { cwd: ctx.repo });
    if (res.code !== 0) {
      failGit('status --porcelain', res, 'BACKEND_UNAVAILABLE');
    }
    const entries: ScmStatusEntry[] = [];
    for (const line of res.stdout.split('\n')) {
      if (line.length === 0) continue;
      // Porcelain v1: `XY <path>` — two status columns, a space, then the path.
      entries.push({ state: line.slice(0, 2), path: line.slice(3) });
    }
    return { dirty: entries.length > 0, entries };
  }

  /**
   * `changed-files <base>` (§4): `git diff --name-status <base>..HEAD` mapped to
   * `{ base, files:[{path, change}] }`, with the §4.4 exclusion filter applied so
   * an excluded path is never reported. A bad/shallow `<base>` surfaces as an
   * error with a deepen hint rather than silently diffing the wrong range.
   */
  async changedFiles(ctx: ScmVerbContext, base: string): Promise<ScmChangedFilesData> {
    const res = await execScm('git', ['diff', '--name-status', `${base}..HEAD`], {
      cwd: ctx.repo,
    });
    if (res.code !== 0) {
      failGit(
        `diff --name-status ${base}..HEAD`,
        res,
        'CONFIG_INVALID',
        'Base ref is unknown or outside the (possibly shallow) history — deepen the clone or pass a reachable base.',
      );
    }

    const parsed: ScmChangedFile[] = [];
    for (const line of res.stdout.split('\n')) {
      if (line.length === 0) continue;
      const fields = line.split('\t');
      const statusField = fields[0] ?? '';
      // For rename/copy (`R100\told\tnew`) the destination path is the last field.
      const path = fields[fields.length - 1] ?? '';
      if (path.length === 0) continue;
      parsed.push({ path, change: mapChangeLetter(statusField) });
    }

    const { excluded } = filterExcluded(parsed.map((f) => f.path));
    const excludedSet = new Set(excluded);
    const files = parsed.filter((f) => !excludedSet.has(f.path));
    return { base, files };
  }

  /**
   * `stage <files…>` (§4): reject the whole call if any path is on the §4.4
   * exclusion list, then `git add -- <files>`. Empty input is a no-op success.
   */
  async stage(ctx: ScmVerbContext, files: string[]): Promise<ScmStageData> {
    const toStage = enforceStageExclusions(files);
    if (toStage.length === 0) {
      return { staged: [] };
    }
    const res = await execScm('git', ['add', '--', ...toStage], { cwd: ctx.repo });
    if (res.code !== 0) {
      failGit('add', res, 'CONFIG_INVALID');
    }
    return { staged: toStage };
  }

  /**
   * `record -m <msg>` (§4): `git commit -m <message>` with the message carried as
   * a discrete argv entry (never interpolated). Nothing staged → a clean
   * `{ recorded:false, changeId:null }` success (§4.1 exit-0 empty result). On a
   * detached HEAD the commit still SUCCEEDS (§4.1 git edge case); after a
   * successful commit, {@link GitBackend.isDetachedHead} is checked and — when
   * detached — a "publish will fail from this state" notice is pushed onto
   * `ctx.warnings` (hardening spec §2.4) for the CLI dispatcher to surface in
   * the envelope's `warnings[]`. The `data` shape itself is unaffected.
   */
  async record(ctx: ScmVerbContext, message: string): Promise<ScmRecordData> {
    const res = await execScm('git', ['commit', '-m', message], { cwd: ctx.repo });
    if (res.code !== 0) {
      const combined = `${res.stdout}\n${res.stderr}`;
      if (/nothing to commit|no changes added|nothing added to commit/i.test(combined)) {
        return { recorded: false, changeId: null, mode: 'commit' };
      }
      if (MISSING_IDENTITY_RE.test(combined)) {
        failGit(
          'commit',
          res,
          'BACKEND_UNAVAILABLE',
          'Set a committer identity: git config user.email "you@example.com" && git config user.name "Your Name".',
        );
      }
      if (HOOK_FAILURE_RE.test(combined)) {
        failGit(
          'commit',
          res,
          'BACKEND_UNAVAILABLE',
          'A git hook (e.g. pre-commit) rejected the commit — inspect and fix the hook in .git/hooks/, or the condition it is checking for.',
        );
      }
      failGit('commit', res, 'DIRTY_TREE');
    }
    const head = await execScm('git', ['rev-parse', 'HEAD'], { cwd: ctx.repo });
    if (head.code !== 0) {
      failGit('rev-parse HEAD', head, 'BACKEND_UNAVAILABLE');
    }
    if (await this.isDetachedHead(ctx)) {
      ctx.warnings?.push('detached HEAD — publish will fail from this state.');
    }
    return { recorded: true, changeId: head.stdout.trim(), mode: 'commit' };
  }

  /** True when `ctx.repo`'s HEAD is detached (no branch); publish will fail from this state (§4.1). */
  async isDetachedHead(ctx: ScmVerbContext): Promise<boolean> {
    const res = await execScm('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: ctx.repo });
    return res.code !== 0;
  }

  /** `change-id` (§4): `git rev-parse HEAD` → `{ ids: [<bare sha>] }` (§5.1 parity — bare SHAs). */
  async changeId(ctx: ScmVerbContext): Promise<ScmChangeIdData> {
    const res = await execScm('git', ['rev-parse', 'HEAD'], { cwd: ctx.repo });
    if (res.code !== 0) {
      failGit('rev-parse HEAD', res, 'BACKEND_UNAVAILABLE');
    }
    return { ids: [res.stdout.trim()] };
  }

  /**
   * `publish` (§4): `git push`. With no upstream, set one to `origin <branch>`;
   * with no `origin` remote at all, fail `NO_REMOTE` (exit 1 — the orchestrator
   * downgrades to record-only, §4.1). `changeId` is the pushed HEAD sha.
   */
  async publish(ctx: ScmVerbContext): Promise<ScmPublishData> {
    const upstream = await execScm(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: ctx.repo },
    );

    let pushRes: ExecScmResult;
    if (upstream.code === 0) {
      pushRes = await execScm('git', ['push'], { cwd: ctx.repo, timeoutMs: PUSH_TIMEOUT_MS });
    } else {
      const remotes = await execScm('git', ['remote'], { cwd: ctx.repo });
      const hasOrigin = remotes.stdout
        .split('\n')
        .map((r) => r.trim())
        .includes('origin');
      if (!hasOrigin) {
        throw new ScmError(
          'NO_REMOTE',
          'cannot publish: HEAD has no upstream and no "origin" remote is configured',
          'Add an "origin" remote, or run record-only with publish disabled.',
        );
      }
      const branch = await execScm('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.repo });
      if (branch.code !== 0) {
        failGit('rev-parse --abbrev-ref HEAD', branch, 'DETACHED_HEAD');
      }
      pushRes = await execScm('git', ['push', '--set-upstream', 'origin', branch.stdout.trim()], {
        cwd: ctx.repo,
        timeoutMs: PUSH_TIMEOUT_MS,
      });
    }

    if (pushRes.code !== 0) {
      const detail = `${pushRes.stdout}\n${pushRes.stderr}`;
      if (
        /no (configured push destination|such remote)|does not appear to be a git repo/i.test(
          detail,
        )
      ) {
        throw new ScmError(
          'NO_REMOTE',
          `git push failed: ${(pushRes.stderr.trim() || pushRes.stdout.trim()).slice(0, 2000)}`,
          'Configure a reachable "origin" remote.',
        );
      }
      failGit('push', pushRes, 'BACKEND_UNAVAILABLE');
    }

    const head = await execScm('git', ['rev-parse', 'HEAD'], { cwd: ctx.repo });
    return { published: true, changeId: head.code === 0 ? head.stdout.trim() : null };
  }

  /**
   * `open-review` (§4): when `openReview` is enabled, `gh pr create --fill`;
   * otherwise a clean skip `{ opened:false, url:null }`. A missing `gh` binary is
   * a clean skip too (§4 "missing gh → clean skip + warning") — the warning is
   * an envelope-layer concern.
   */
  async openReview(ctx: ScmVerbContext): Promise<ScmOpenReviewData> {
    const { behaviors } = resolveGitBehaviors(ctx.repo);
    if (!behaviors.openReview) {
      return { opened: false, url: null };
    }
    let res: ExecScmResult;
    try {
      res = await execScm('gh', ['pr', 'create', '--fill'], { cwd: ctx.repo });
    } catch (err) {
      // Missing `gh` → execScm rejects BACKEND_UNAVAILABLE; treat as a clean skip.
      if (err instanceof ScmError && err.code === 'BACKEND_UNAVAILABLE') {
        return { opened: false, url: null };
      }
      throw err;
    }
    if (res.code !== 0) {
      return { opened: false, url: null };
    }
    const url = res.stdout.trim().split('\n').filter(Boolean).pop() ?? null;
    return { opened: true, url };
  }

  /**
   * `isolate <id>` (§4): git isolation is provided by the Claude Code platform
   * harness (`isolation:"worktree"` on the Agent call), which a CLI subprocess
   * cannot request. So this is a capability report only — no worktree is created
   * here; the orchestrator sets `isolation:"worktree"` on dispatch (§4, §5.2).
   */
  async isolate(_ctx: ScmVerbContext, _id: string): Promise<ScmIsolateData> {
    return { strategy: 'platform-worktree' };
  }

  /**
   * `teardown-isolation <id>` (§4): git worktrees are platform-managed and this
   * backend records none of its own (isolate is a no-op), so teardown is a no-op
   * success — it never sweeps `.claude/worktrees/*` wholesale (§4).
   */
  async teardownIsolation(_ctx: ScmVerbContext, _id: string): Promise<ScmTeardownIsolationData> {
    return { tornDown: true };
  }

  /** `reset-hard <ref>` (§4): `git reset --hard <ref>` → `{ reset:true }`. */
  async resetHard(ctx: ScmVerbContext, ref: string): Promise<ScmResetHardData> {
    const res = await execScm('git', ['reset', '--hard', ref], { cwd: ctx.repo });
    if (res.code !== 0) {
      failGit(`reset --hard ${ref}`, res, 'CONFIG_INVALID', 'Is <ref> a valid, known commit/ref?');
    }
    return { reset: true };
  }
}

/** Shared stateless git backend instance (§4 — per-context state lives in the repo, not the object). */
export const gitBackend = new GitBackend();
