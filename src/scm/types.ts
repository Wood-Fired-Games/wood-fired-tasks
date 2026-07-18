/**
 * Shared TypeScript contract for the pluggable-SCM adapter.
 *
 * Types only — no backend logic. Backend implementations
 * (`git-adapter.ts`, `perforce-adapter.ts`, `none-adapter.ts`) implement
 * {@link ScmBackend} against these shapes; `src/cli/` wraps each adapter
 * call into the wire envelope defined here before printing it to stdout.
 *
 * Normative source: `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`
 * — see the section references on each export below.
 */

// ---------------------------------------------------------------------------
// Backend & configuration (spec §2, §3.1, §3.3)
// ---------------------------------------------------------------------------

/** A resolved SCM backend — never `"auto"` once `detect` has run (§3.2). */
export type ScmBackendName = 'git' | 'perforce' | 'none';

/** The `backend` value as written in `.tasks/scm.json` (§3.1) — `"auto"` triggers §3.2 resolution. */
export type ScmBackendConfigValue = ScmBackendName | 'auto';

/** The `behaviors` toggles from `.tasks/scm.json` (§3.1), fully resolved (no gaps — see §3.3 defaults). */
export interface ScmBehaviors {
  commit: boolean;
  isolate: boolean;
  publish: boolean;
  openReview: boolean;
  branchPerRun: boolean;
}

/** Shape of `.tasks/scm.json` on disk (§3.1). `behaviors`/`ignore` are optional — per-backend defaults fill gaps (§3.3). */
export interface ScmConfigFile {
  version: 1;
  backend: ScmBackendConfigValue;
  behaviors?: Partial<ScmBehaviors>;
  /** none-backend only: extra gitignore-style globs excluded from the baseline manifest (§3.1, §5.5). */
  ignore?: string[];
}

/** How isolation is actually achieved for the resolved backend (§4 `isolate`, §5.2). */
export type ScmIsolationCapability = 'platform-worktree' | 'p4-client' | 'serialized' | 'shared';

// ---------------------------------------------------------------------------
// Verb identifiers (spec §4 verb table)
// ---------------------------------------------------------------------------

export const SCM_VERBS = [
  'detect',
  'baseline',
  'status',
  'changed-files',
  'stage',
  'record',
  'change-id',
  'publish',
  'open-review',
  'isolate',
  'teardown-isolation',
  'reset-hard',
] as const;

/** Verb name exactly as it appears in the wire envelope's `verb` field (§4.1) and the §4 verb table. */
export type ScmVerb = (typeof SCM_VERBS)[number];

// ---------------------------------------------------------------------------
// Per-verb `data` shapes (spec §4.1 "Per-verb data shapes (normative)")
// ---------------------------------------------------------------------------

export interface ScmDetectData {
  backend: ScmBackendName;
  source: 'file' | 'charter' | 'auto';
  behaviors: ScmBehaviors;
  capabilities: { isolation: ScmIsolationCapability };
}

export interface ScmBaselineData {
  /** `<sha>` (git) | `p4:<cl>` (perforce) | `none:<sha256-of-canonical-manifest>` (none, §5.5). */
  id: string;
  /** Path to the digest manifest — none backend only (§5.5). */
  manifestPath?: string;
}

export interface ScmStatusEntry {
  path: string;
  state: string;
}

export interface ScmStatusData {
  dirty: boolean;
  entries: ScmStatusEntry[];
}

export type ScmFileChangeType = 'added' | 'modified' | 'deleted';

export interface ScmChangedFile {
  path: string;
  change: ScmFileChangeType;
}

export interface ScmChangedFilesData {
  base: string;
  files: ScmChangedFile[];
}

export type ScmRecordMode = 'commit' | 'submit' | 'shelve' | 'noop';

export interface ScmRecordData {
  recorded: boolean;
  changeId: string | null;
  mode: ScmRecordMode;
}

export interface ScmChangeIdData {
  ids: string[];
}

export interface ScmPublishData {
  published: boolean;
  /** perforce: the final, renumbered CL (§4.2) — never a pending CL number. */
  changeId: string | null;
}

export interface ScmIsolateData {
  strategy: ScmIsolationCapability;
  /** Scratch dir — perforce only. */
  path?: string;
  /** p4 client name — perforce only. */
  client?: string;
}

/**
 * §4.1's normative "Per-verb data shapes" list does not enumerate `stage`,
 * `open-review`, `teardown-isolation`, or `reset-hard`. The four shapes below
 * are inferred to complete {@link ScmBackend}, following the same
 * boolean-flag + nullable-detail convention the spec uses for `record` /
 * `publish`. Tighten these if a later spec revision makes them normative.
 */
export interface ScmStageData {
  staged: string[];
}

export interface ScmOpenReviewData {
  opened: boolean;
  url: string | null;
}

export interface ScmTeardownIsolationData {
  tornDown: boolean;
}

export interface ScmResetHardData {
  reset: boolean;
}

/** Maps each {@link ScmVerb} to its normative `data` shape — backs the generic envelope types below. */
export interface ScmVerbDataMap {
  detect: ScmDetectData;
  baseline: ScmBaselineData;
  status: ScmStatusData;
  'changed-files': ScmChangedFilesData;
  stage: ScmStageData;
  record: ScmRecordData;
  'change-id': ScmChangeIdData;
  publish: ScmPublishData;
  'open-review': ScmOpenReviewData;
  isolate: ScmIsolateData;
  'teardown-isolation': ScmTeardownIsolationData;
  'reset-hard': ScmResetHardData;
}

// ---------------------------------------------------------------------------
// Wire envelope (spec §4.1 "Wire contract — output schema + exit codes")
// ---------------------------------------------------------------------------

/** Stable error codes (§4.1 minimum set) — the `error.code` field is always one of these. */
export const SCM_ERROR_CODES = [
  'CONFIG_INVALID',
  'BACKEND_UNAVAILABLE',
  'AUTH_EXPIRED',
  'NO_REMOTE',
  'SUBMIT_CONFLICT',
  'UNSUPPORTED_VERB',
  'TIMEOUT',
  'DIRTY_TREE',
  'DETACHED_HEAD',
] as const;

export type ScmErrorCode = (typeof SCM_ERROR_CODES)[number];

export interface ScmErrorPayload {
  code: ScmErrorCode;
  message: string;
  hint?: string;
}

/**
 * The success envelope every verb prints on stdout (§4.1):
 * `{ "ok": true, "verb", "backend", "context", "data": {}, "warnings": [] }`.
 * `data` is narrowed per-verb via {@link ScmVerbDataMap}.
 */
export interface ScmSuccessEnvelope<V extends ScmVerb = ScmVerb> {
  ok: true;
  verb: V;
  backend: ScmBackendName;
  context: string;
  data: ScmVerbDataMap[V];
  warnings: string[];
}

/**
 * The failure envelope (§4.1): `ok` is `false` and `data` is replaced by `error`.
 */
export interface ScmErrorEnvelope<V extends ScmVerb = ScmVerb> {
  ok: false;
  verb: V;
  backend: ScmBackendName;
  context: string;
  error: ScmErrorPayload;
  warnings?: string[];
}

/** The full `{ok, ...}` JSON envelope a verb invocation prints (§4.1). */
export type ScmEnvelope<V extends ScmVerb = ScmVerb> = ScmSuccessEnvelope<V> | ScmErrorEnvelope<V>;

/**
 * Thrown by {@link ScmBackend} methods to signal a verb failure. The CLI
 * dispatcher (`src/cli/`) catches this, maps `.code` to the §4.1 exit-code
 * table via {@link SCM_EXIT_CODES}, and prints the resulting
 * {@link ScmErrorEnvelope}. Mirrors the `NotAuthenticatedError` /
 * `BusinessError` pattern in `src/services/errors.ts`.
 */
export class ScmError extends Error {
  public override readonly name = 'ScmError';
  public readonly code: ScmErrorCode;
  public readonly hint?: string;

  constructor(code: ScmErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    if (hint !== undefined) {
      this.hint = hint;
    }

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, ScmError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Exit codes (spec §4.1 "Exit codes (convention, enforced by tests)")
// ---------------------------------------------------------------------------

export const SCM_EXIT_CODES = {
  /** Success — including empty results (`changed-files` with nothing changed, `record` with nothing staged). */
  SUCCESS: 0,
  /** SCM operation failed (push rejected, submit conflict, merge needed). Retryable after remediation. */
  OPERATION_FAILED: 1,
  /** Usage / config error (unknown verb, invalid `.tasks/scm.json`, ambiguous auto-detect). Not retryable. */
  USAGE_OR_CONFIG_ERROR: 2,
  /** Backend unavailable (p4 server unreachable, expired ticket, `git`/`p4` binary missing). Retryable after recovery. */
  BACKEND_UNAVAILABLE: 3,
  /** Verb unsupported for this backend/toggle combination (e.g. none-mode `reset-hard`). Never retryable. */
  UNSUPPORTED_VERB: 4,
  /** Inner command exceeded the exec timeout (§6.1). Maybe retryable. */
  TIMEOUT: 124,
} as const;

export type ScmExitCode = (typeof SCM_EXIT_CODES)[keyof typeof SCM_EXIT_CODES];

// ---------------------------------------------------------------------------
// Adapter contract (spec §4 verb table, §6.1)
// ---------------------------------------------------------------------------

/**
 * Global scoping every verb call carries (§4): `--repo` (resolution root
 * override, §3.2) and `--context` (caller-chosen scope key namespacing
 * per-run state — none-mode baselines, perforce numbered changelists,
 * temp-client names). Callers MUST pass distinct `context` values for
 * parallel orchestrators.
 */
export interface ScmVerbContext {
  /** Absolute path to the resolved repo root. */
  repo: string;
  /** Scope key; CLI default is `"default"` (§4). */
  context: string;
  /**
   * Mutable non-fatal-warning collector threaded by the CLI dispatcher
   * (`src/cli/commands/scm.ts`, hardening spec §2.4) for the lifetime of one
   * verb invocation. A backend method that discovers a non-fatal condition
   * worth surfacing (e.g. `git.ts`'s `record()` on a detached HEAD) pushes a
   * message here; the dispatcher copies the accumulated array into the
   * envelope's `warnings[]` field. Optional — absent when a caller (e.g. a
   * backend unit test) constructs a bare `{ repo, context }` context, so
   * methods MUST guard with `ctx.warnings?.push(...)`.
   */
  warnings?: string[];
}

/**
 * One method per §4 adapter verb. Each backend (`git-adapter.ts`,
 * `perforce-adapter.ts`, `none-adapter.ts`) implements this interface;
 * methods resolve with the verb's normative `data` shape on success and
 * reject with {@link ScmError} on failure — the CLI layer wraps both into
 * the {@link ScmEnvelope} and exit code.
 */
export interface ScmBackend {
  readonly name: ScmBackendName;

  detect(ctx: ScmVerbContext): Promise<ScmDetectData>;
  baseline(ctx: ScmVerbContext): Promise<ScmBaselineData>;
  status(ctx: ScmVerbContext): Promise<ScmStatusData>;
  changedFiles(ctx: ScmVerbContext, base: string): Promise<ScmChangedFilesData>;
  stage(ctx: ScmVerbContext, files: string[]): Promise<ScmStageData>;
  record(ctx: ScmVerbContext, message: string): Promise<ScmRecordData>;
  changeId(ctx: ScmVerbContext): Promise<ScmChangeIdData>;
  publish(ctx: ScmVerbContext): Promise<ScmPublishData>;
  openReview(ctx: ScmVerbContext): Promise<ScmOpenReviewData>;
  isolate(ctx: ScmVerbContext, id: string): Promise<ScmIsolateData>;
  teardownIsolation(ctx: ScmVerbContext, id: string): Promise<ScmTeardownIsolationData>;
  resetHard(ctx: ScmVerbContext, ref: string): Promise<ScmResetHardData>;
}
