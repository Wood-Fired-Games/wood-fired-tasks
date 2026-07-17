/**
 * Perforce backend for the pluggable-SCM adapter (spec §4, §4.1 preflight,
 * §4.2 semantic collapse, §4.3 failure modes).
 *
 * Implements {@link ScmBackend} entirely through {@link execScm} (the §6.1
 * argv-only exec wrapper); nothing here spawns a child process directly, and no
 * caller text is ever interpolated into a shell string. `P4PASSWD` is never read
 * or echoed — the exec wrapper strips it from the child env and scrubs it from
 * captured output.
 *
 * Two perforce facts drive the shape of this file:
 *
 *   - **§4.2 semantic collapse** — in perforce, *commit = submit = publish* is a
 *     single act. The skills' universal `record → publish` sequence maps to:
 *       - commit on + publish on  → `p4 submit` (performed in {@link publish}),
 *       - commit on + publish off → a shelved / pending changelist (recorded,
 *         unpublished; the shelved CL number is the durable id),
 *       - commit off              → reconcile-only, no submit.
 *   - **Renumbering (evidence-critical, §4.2)** — `p4 submit` renumbers the
 *     pending changelist (123 → 456). When publish is ON the change-id is
 *     captured **after** submit returns, parsing the final CL from the submit
 *     output into `publish.data.changeId = "p4:<final-cl>"`. A pending CL number
 *     is never quoted as evidence in a publish-on run.
 *
 * The exec function is injectable via the constructor so unit tests can mock the
 * p4 layer (no real p4 server is required to exercise the collapse, renumber,
 * and §4.3 submit-conflict policy).
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`
 * §4, §4.1–§4.3.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadScmConfig } from './config.js';
import { resolveBackend } from './detect.js';
import type { ExecScmOptions, ExecScmResult } from './exec.js';
import { execScm } from './exec.js';
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

/** The exec signature the backend depends on — {@link execScm} in production, a mock in tests. */
export type ExecScmFn = (
  binary: string,
  args: readonly string[],
  opts: ExecScmOptions,
) => Promise<ExecScmResult>;

/**
 * Per-backend behavior defaults for perforce (spec §3.3): commit on, publish on,
 * everything else off. `isolate` defaults off (shared-tree-serialized) because
 * true p4 isolation requires a temp-client template (§5.2) — surfaced through
 * `detect`'s `capabilities.isolation`, not this toggle.
 */
export const PERFORCE_BEHAVIOR_DEFAULTS: ScmBehaviors = {
  commit: true,
  isolate: false,
  publish: true,
  openReview: false,
  branchPerRun: false,
};

/** Submit / sync get the longer §6.1 timeout (300s) — these can be slow against a busy server. */
const SUBMIT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Output parsing (kept pure + exported so tests can pin the regexes)
// ---------------------------------------------------------------------------

/** Parse the CL number from `p4 change` output ("Change 123 created."). */
export function parseCreatedChange(out: string): number | null {
  const m = out.match(/change (\d+) created/i);
  return m ? Number(m[1]) : null;
}

/**
 * Parse the FINAL submitted CL from `p4 submit` output, honoring renumbering:
 * "Change 123 renamed change 456 and submitted." → 456; "Change 456 submitted."
 * → 456. Returns `null` when neither form is present.
 */
export function parseSubmittedChange(out: string): number | null {
  const renamed = out.match(/renamed change (\d+)/i);
  if (renamed) return Number(renamed[1]);
  const submitted = out.match(/change (\d+) submitted/i);
  return submitted ? Number(submitted[1]) : null;
}

/** Parse the newest submitted CL from `p4 changes -m1 …` output. */
export function parseLatestChange(out: string): string | null {
  const m = out.match(/^change (\d+)/im);
  return m?.[1] ?? null;
}

interface OpenedFile {
  path: string;
  action: string;
}

/**
 * Parse `p4 opened` lines of the form
 * `//depot/path/file#3 - edit change 123 (text)` into `{ path, action }`.
 */
export function parseOpened(out: string): OpenedFile[] {
  const files: OpenedFile[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)#\d+ - (\S+)/);
    const path = m?.[1];
    const action = m?.[2];
    if (path && action) {
      files.push({ path, action });
    }
  }
  return files;
}

/** Map a p4 `opened` action to the wire-contract change type (§4.1). */
export function changeTypeForAction(action: string): ScmFileChangeType {
  if (action === 'add' || action === 'branch' || action === 'move/add') return 'added';
  if (action === 'delete' || action === 'move/delete' || action === 'purge') return 'deleted';
  return 'modified';
}

/**
 * True when a non-zero `p4 submit` result is a "files out of date" submit
 * conflict (§4.3) — the case the sync + `resolve -as` + retry-once policy
 * targets, as opposed to an auth/permission/infra failure.
 */
export function isSubmitConflict(res: ExecScmResult): boolean {
  if (res.code === 0) return false;
  const text = `${res.stdout}\n${res.stderr}`.toLowerCase();
  return (
    /out of date/.test(text) ||
    /not up.?to.?date/.test(text) ||
    /must (be )?resolve/.test(text) ||
    /resolve .*before/.test(text) ||
    /merges? .*(pending|still)/.test(text) ||
    /files? .*must be resolved/.test(text) ||
    /needs? resolve/.test(text)
  );
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class PerforceBackend implements ScmBackend {
  public readonly name = 'perforce' as const;

  private readonly exec: ExecScmFn;

  /** @param exec p4 exec function; defaults to the §6.1 {@link execScm} wrapper. Injected in tests. */
  constructor(exec: ExecScmFn = execScm) {
    this.exec = exec;
  }

  // --- exec + preflight -----------------------------------------------------

  /** Run an allowlisted `p4` command pinned to the repo root (§6.1). */
  private p4(
    ctx: ScmVerbContext,
    args: readonly string[],
    opts: Partial<ExecScmOptions> = {},
  ): Promise<ExecScmResult> {
    return this.exec('p4', args, { cwd: ctx.repo, ...opts });
  }

  /**
   * §4.1 perforce preflight: probe the session with `p4 login -s`. An expired
   * ticket → `AUTH_EXPIRED`; an unreachable server → `BACKEND_UNAVAILABLE`
   * (both exit 3). Never interactive; never reads/echoes `P4PASSWD`. A missing
   * `p4` binary surfaces as the `BACKEND_UNAVAILABLE` that {@link execScm}
   * already rejects with.
   */
  private async preflight(ctx: ScmVerbContext): Promise<void> {
    const res = await this.p4(ctx, ['login', '-s']);
    if (res.code === 0) return;
    const text = `${res.stdout}\n${res.stderr}`;
    if (
      /connect to server failed|connect|tcp|network|unreachable|refused|no such host/i.test(text)
    ) {
      throw new ScmError(
        'BACKEND_UNAVAILABLE',
        'perforce server is unreachable (p4 login -s failed to connect)',
        'Check P4PORT / network connectivity to the Perforce server.',
      );
    }
    throw new ScmError(
      'AUTH_EXPIRED',
      'perforce session is not authenticated (p4 login -s reported no valid ticket)',
      'Run `p4 login` to refresh the ticket; the adapter never prompts interactively.',
    );
  }

  // --- per-context changelist state ----------------------------------------

  /** Path of the per-context pending-CL record under adapter runtime state (§3.1, §4.4). */
  private clStatePath(ctx: ScmVerbContext): string {
    return join(ctx.repo, '.tasks', '.scm', ctx.context, 'changelist.json');
  }

  /** The numbered pending CL recorded for this context, or `null` if none yet. */
  private readContextCl(ctx: ScmVerbContext): number | null {
    const path = this.clStatePath(ctx);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cl?: unknown };
      return typeof parsed.cl === 'number' ? parsed.cl : null;
    } catch {
      return null;
    }
  }

  /** Record the numbered CL for this context (post-renumber value after submit). */
  private writeContextCl(ctx: ScmVerbContext, cl: number): void {
    const path = this.clStatePath(ctx);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ cl }), 'utf8');
  }

  /**
   * Non-interactive changelist form write (task #1555): `p4 change -i` READS
   * THE FORM FROM STDIN — `--field` only rewrites the OUTPUT of a form
   * command (`change -o`), it does not seed `-i`'s input. Since the §6.1 exec
   * wrapper pins stdin to `'ignore'` by default, a bare `--field … change -i`
   * cannot work against a real server (it reads an empty/absent form).
   *
   * The canonical fix: (1) run `p4 --field <fields…> change -o` and capture
   * its stdout — the pre-filled changespec form with those fields already
   * rewritten; (2) pipe that captured form verbatim into `p4 change -i` via
   * {@link ExecScmOptions.stdinData}. Neither call is ever interactive.
   */
  private async writeChangelistForm(
    ctx: ScmVerbContext,
    fields: readonly string[],
  ): Promise<ExecScmResult> {
    const fieldArgs = fields.flatMap((f) => ['--field', f]);
    const form = await this.p4(ctx, [...fieldArgs, 'change', '-o']);
    if (form.code !== 0) throw genericFailure('change -o', form);
    return this.p4(ctx, ['change', '-i'], { stdinData: form.stdout });
  }

  /**
   * The context's numbered pending changelist, created lazily on first stage
   * (§4.3 — each `--context` gets its OWN numbered CL so concurrent workers in
   * one client cannot cross-contaminate the default changelist).
   *
   * Created via the {@link writeChangelistForm} `change -o` | `change -i`
   * path (task #1555) — the pre-filled form (fresh "new" changespec with the
   * description already rewritten by `--field`) is captured then piped to
   * `-i` on stdin.
   */
  private async ensureContextChangelist(ctx: ScmVerbContext): Promise<number> {
    const existing = this.readContextCl(ctx);
    if (existing !== null) return existing;

    const description = `wft-scm context ${ctx.context}`;
    const res = await this.writeChangelistForm(ctx, [`Description=${description}`]);
    if (res.code !== 0) throw genericFailure('create changelist', res);

    const cl = parseCreatedChange(res.stdout);
    if (cl === null) {
      throw new ScmError(
        'BACKEND_UNAVAILABLE',
        'could not parse a changelist number from `p4 change` output',
        undefined,
      );
    }
    this.writeContextCl(ctx, cl);
    return cl;
  }

  /**
   * Set an existing numbered CL's description via the same {@link
   * writeChangelistForm} `change -o` | `change -i` path (task #1555), scoping
   * the form to the target CL with `Change=<cl>` alongside `Description=…`.
   */
  private async setChangelistDescription(
    ctx: ScmVerbContext,
    cl: number,
    message: string,
  ): Promise<void> {
    const res = await this.writeChangelistForm(ctx, [`Change=${cl}`, `Description=${message}`]);
    if (res.code !== 0) throw genericFailure('update changelist description', res);
  }

  // --- verbs ----------------------------------------------------------------

  async detect(ctx: ScmVerbContext): Promise<ScmDetectData> {
    // Detection reads config/markers only — it must not hard-fail on an expired
    // ticket (you can still report which backend a repo uses when offline).
    const resolved = resolveBackend(ctx.repo);
    const behaviors = resolveBehaviors(ctx.repo);
    const isolation = hasClientTemplate() ? 'p4-client' : 'serialized';
    return {
      backend: 'perforce',
      source: resolved.source,
      behaviors,
      capabilities: { isolation },
    };
  }

  async baseline(ctx: ScmVerbContext): Promise<ScmBaselineData> {
    await this.preflight(ctx);
    const res = await this.p4(ctx, ['changes', '-m1', '-s', 'submitted', '//...#have']);
    if (res.code !== 0) throw genericFailure('changes', res);
    const cl = parseLatestChange(res.stdout) ?? '0';
    return { id: `p4:${cl}` };
  }

  async status(ctx: ScmVerbContext): Promise<ScmStatusData> {
    await this.preflight(ctx);
    const res = await this.p4(ctx, ['opened']);
    const entries: ScmStatusEntry[] = parseOpened(res.stdout).map((o) => ({
      path: o.path,
      state: o.action,
    }));
    return { dirty: entries.length > 0, entries };
  }

  async changedFiles(ctx: ScmVerbContext, base: string): Promise<ScmChangedFilesData> {
    await this.preflight(ctx);
    const cl = this.readContextCl(ctx);
    const args = cl !== null ? ['opened', '-c', String(cl)] : ['opened'];
    const res = await this.p4(ctx, args);

    const changed: ScmChangedFile[] = parseOpened(res.stdout).map((o) => ({
      path: o.path,
      change: changeTypeForAction(o.action),
    }));

    // §4.4: `changed-files` silently filters excluded paths — it must NEVER
    // report an adapter-runtime / planning-artifact path, for any backend.
    const { kept } = filterExcluded(changed.map((c) => c.path));
    const keptSet = new Set(kept);
    return { base, files: changed.filter((c) => keptSet.has(c.path)) };
  }

  async stage(ctx: ScmVerbContext, files: string[]): Promise<ScmStageData> {
    await this.preflight(ctx);

    // §4.4: reject the whole call if ANY path is on the central exclusion list
    // (CONFIG_INVALID → exit 2). Nothing is silently dropped for `stage`.
    const toStage = enforceStageExclusions(files);
    if (toStage.length === 0) return { staged: [] };

    // p4 has no `--` end-of-options terminator (it treats a bare `--` as a
    // filespec and errors) and offers no positional escape for leading-dash
    // filenames, so a path beginning with `-` must be rejected up front rather
    // than passed through to argv, where it would be parsed as a flag.
    const leadingDash = toStage.find((p) => p.startsWith('-'));
    if (leadingDash !== undefined) {
      throw new ScmError(
        'CONFIG_INVALID',
        `refusing to stage path "${leadingDash}": perforce has no way to distinguish a leading-dash filename from a flag (p4 does not support "--" as an end-of-options terminator)`,
        'rename the file so it does not start with "-", or stage it via a different mechanism',
      );
    }

    const cl = await this.ensureContextChangelist(ctx);
    // `p4 reconcile` opens files for add/edit/delete as appropriate, into the
    // context's numbered pending CL (never the default CL, §4.3). No `--`
    // terminator is used — p4 does not support one (leading-dash paths are
    // rejected above, before any p4 invocation runs).
    const res = await this.p4(ctx, ['reconcile', '-c', String(cl), ...toStage]);
    if (res.code !== 0) throw genericFailure('reconcile (stage)', res);
    return { staged: toStage };
  }

  async record(ctx: ScmVerbContext, message: string): Promise<ScmRecordData> {
    await this.preflight(ctx);
    const behaviors = resolveBehaviors(ctx.repo);

    // §4.2: commit off → reconcile-only, nothing recorded.
    if (!behaviors.commit) {
      return { recorded: false, changeId: null, mode: 'noop' };
    }

    const cl = await this.ensureContextChangelist(ctx);
    await this.setChangelistDescription(ctx, cl, message);

    if (behaviors.publish) {
      // §4.2 collapse: commit on + publish on → the change is submitted, but the
      // SUBMIT (and the evidence-critical renumber capture) happens in publish()
      // so the durable id is the FINAL, renumbered CL. record defers: the
      // pending CL is not a durable id, so changeId is null here.
      return { recorded: true, changeId: null, mode: 'submit' };
    }

    // §4.2 collapse: commit on + publish off → keep a shelved / pending CL
    // (recorded, unpublished). Shelving does not renumber, so the pending CL
    // number is the durable id.
    const shelve = await this.p4(ctx, ['shelve', '-f', '-c', String(cl)]);
    if (shelve.code !== 0) throw genericFailure('shelve', shelve);
    return { recorded: true, changeId: `p4:${cl}`, mode: 'shelve' };
  }

  async changeId(ctx: ScmVerbContext): Promise<ScmChangeIdData> {
    await this.preflight(ctx);
    // The context's CL number — post-renumber once submitted (publish() rewrites
    // the recorded CL to the final submitted number, §4.2/§4.3).
    const cl = this.readContextCl(ctx);
    return { ids: cl !== null ? [`p4:${cl}`] : [] };
  }

  async publish(ctx: ScmVerbContext): Promise<ScmPublishData> {
    await this.preflight(ctx);
    const behaviors = resolveBehaviors(ctx.repo);
    if (!behaviors.publish) return { published: false, changeId: null };

    const cl = this.readContextCl(ctx);
    if (cl === null) {
      // Nothing was staged/recorded for this context — nothing to submit.
      return { published: false, changeId: null };
    }

    // First attempt.
    const first = await this.submit(ctx, cl);
    if (first.ok) return this.finishPublish(ctx, first.cl);
    if (!first.conflict) throw genericFailure('submit', first.res);

    // §4.3 submit-conflict policy: sync + `resolve -as` (accept-safe, AUTOMATIC
    // merges only) and retry the submit EXACTLY once. The adapter never runs
    // `-at`/`-ay` and never reverts a conflicted CL.
    await this.p4(ctx, ['sync'], { timeoutMs: SUBMIT_TIMEOUT_MS });
    await this.p4(ctx, ['resolve', '-as']);

    const second = await this.submit(ctx, cl);
    if (second.ok) return this.finishPublish(ctx, second.cl);
    if (!second.conflict) throw genericFailure('submit', second.res);

    // Remaining conflict → SUBMIT_CONFLICT (exit 1); files left opened in the
    // numbered CL for a human. The CL number is reported so nothing is orphaned.
    throw new ScmError(
      'SUBMIT_CONFLICT',
      `p4 submit of changelist ${cl} still conflicts after sync + resolve -as; files remain opened in changelist ${cl}`,
      'Resolve the changelist manually (`p4 resolve`) and re-submit — the adapter never runs -at/-ay.',
    );
  }

  /** Record the renumbered CL and return the publish envelope's `data` (§4.2). */
  private finishPublish(ctx: ScmVerbContext, finalCl: number): ScmPublishData {
    this.writeContextCl(ctx, finalCl);
    return { published: true, changeId: `p4:${finalCl}` };
  }

  /**
   * Submit the context CL once. A zero exit resolves `{ ok: true, cl: <final> }`
   * with the renumbered CL parsed from output; a non-zero exit resolves
   * `{ ok: false }` and flags whether it is a §4.3 submit conflict.
   */
  private async submit(
    ctx: ScmVerbContext,
    cl: number,
  ): Promise<{ ok: true; cl: number } | { ok: false; conflict: boolean; res: ExecScmResult }> {
    const res = await this.p4(ctx, ['submit', '-c', String(cl)], { timeoutMs: SUBMIT_TIMEOUT_MS });
    if (res.code === 0) {
      return { ok: true, cl: parseSubmittedChange(res.stdout) ?? cl };
    }
    return { ok: false, conflict: isSubmitConflict(res), res };
  }

  async openReview(ctx: ScmVerbContext): Promise<ScmOpenReviewData> {
    await this.preflight(ctx);
    const behaviors = resolveBehaviors(ctx.repo);
    if (!behaviors.openReview) return { opened: false, url: null };

    const cl = this.readContextCl(ctx);
    if (cl === null) return { opened: false, url: null };

    // §4 table: perforce open-review = `p4 shelve` (+ swarm). The swarm URL is
    // not knowable from the CLI here, so it is reported as null.
    const shelve = await this.p4(ctx, ['shelve', '-f', '-c', String(cl)]);
    if (shelve.code !== 0) throw genericFailure('shelve (open-review)', shelve);
    return { opened: true, url: null };
  }

  async isolate(ctx: ScmVerbContext, id: string): Promise<ScmIsolateData> {
    await this.preflight(ctx);
    // §5.2: real p4 isolation provisions a temp client from a configured
    // template; with no template the loop degrades to shared-tree-serialized.
    if (!hasClientTemplate()) {
      return { strategy: 'serialized' };
    }
    const client = `wft-${ctx.context}-${id}`;
    const path = join(ctx.repo, '.tasks', '.scm', ctx.context, 'client');
    return { strategy: 'p4-client', client, path };
  }

  async teardownIsolation(ctx: ScmVerbContext, id: string): Promise<ScmTeardownIsolationData> {
    await this.preflight(ctx);
    // §4 table: revert the temp client's opened files first, then delete it.
    // Best-effort — a missing client or already-reverted files are not errors.
    await this.p4(ctx, ['revert', '-a']);
    await this.p4(ctx, ['client', '-d', `wft-${ctx.context}-${id}`]);
    return { tornDown: true };
  }

  async resetHard(ctx: ScmVerbContext, ref: string): Promise<ScmResetHardData> {
    await this.preflight(ctx);
    // §4 table: perforce reset-hard = `p4 revert -a` + `p4 sync @<cl>`.
    const cl = ref.replace(/^p4:/, '').trim();
    const revert = await this.p4(ctx, ['revert', '-a']);
    if (revert.code !== 0) throw genericFailure('revert', revert);

    const syncArgs = cl === '' ? ['sync'] : ['sync', `@${cl}`];
    const sync = await this.p4(ctx, syncArgs, { timeoutMs: SUBMIT_TIMEOUT_MS });
    if (sync.code !== 0) throw genericFailure('sync', sync);
    return { reset: true };
  }
}

/** Production singleton — wraps the real {@link execScm}. */
export const perforceBackend = new PerforceBackend();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge the §3.3 perforce defaults with any `behaviors` overrides in `.tasks/scm.json`. */
function resolveBehaviors(repo: string): ScmBehaviors {
  const config = loadScmConfig(repo);
  return { ...PERFORCE_BEHAVIOR_DEFAULTS, ...(config?.behaviors ?? {}) };
}

/** True when a temp-client template is configured (§5.2) → `capabilities.isolation === 'p4-client'`. */
function hasClientTemplate(): boolean {
  const template = process.env['P4CLIENT_TEMPLATE'];
  return template !== undefined && template !== '';
}

/**
 * Map a failed (non-conflict, non-auth) p4 command to a stable {@link ScmError}.
 * Auth and submit-conflict have their own dedicated codes; everything else is
 * surfaced as `BACKEND_UNAVAILABLE` with the (already secret-scrubbed) tail.
 */
function genericFailure(operation: string, res: ExecScmResult): ScmError {
  const detail = (res.stderr || res.stdout || '').trim();
  return new ScmError(
    'BACKEND_UNAVAILABLE',
    `p4 ${operation} failed (exit ${res.code ?? 'null'})${detail ? `: ${detail}` : ''}`,
    undefined,
  );
}
