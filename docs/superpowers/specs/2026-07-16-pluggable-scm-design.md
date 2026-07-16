# Pluggable Source Control (SCM) for Skills & Tooling — Design

- **Date:** 2026-07-16
- **Status:** Approved design; pending implementation plan
- **Author:** brainstorming session (Stuart + Claude)
- **Scope of this spec:** the whole `wood-fired-tasks` skill + tooling surface that currently assumes git.

## 1. Problem & goal

Today every source-control action in `wood-fired-tasks` assumes **git**. The coupling is not
in code — a thorough map (see §9, "Codebase reality") found **zero direct git invocation in
`src/` or `packages/`**. All git behavior is either (a) **model-instruction prose** in the
`skills/` markdown (commit, push, status, diff, rev-parse, worktree teardown, evidence
capture) or (b) **worktree isolation owned by the Claude Code platform harness**, which is
git-only and out-of-repo.

**Goal:** let a user select the source-control system a repo uses — **git**, **perforce**, or
**none** — and configure *which* SCM behaviors happen (commits, isolation/worktrees, publish,
review, branch-per-run). Those preferences MUST be upheld mechanically by every skill and tool,
not left to model discretion.

All three backends are **first-class in v1**. "none" means: perform no version-control
operations at all, while the task loop still functions (baseline/verify via filesystem diff).

## 2. Key decisions (locked)

1. **Backends:** `git`, `perforce`, `none` — all working in v1.
2. **Enforcement:** a single **adapter CLI** (`tasks scm <verb>`). Skills call verbs; the CLI
   dispatches to the configured backend and honors the toggles. This is the only SCM chokepoint.
   Rationale: branching "3 backends × many git verbs" through prose in every skill would drift
   (the project has a documented dual-source drift trap) and depend on model compliance.
3. **Config home:** a committed, repo-local **`.tasks/scm.json`** plus auto-detect. SCM backend
   is a per-**repo** property, and a single tasks-project can span multiple repos (cross-repo
   tasks exist), so config lives with the repo, not the project. The adapter reads it off the
   filesystem with no DB round-trip.

## 3. Configuration

### 3.1 File schema — `.tasks/scm.json`

```json
{
  "version": 1,
  "backend": "git",
  "behaviors": {
    "commit":       true,
    "isolate":      true,
    "publish":      true,
    "openReview":   false,
    "branchPerRun": false
  }
}
```

- `backend`: `"git" | "perforce" | "none" | "auto"`.
- `behaviors` (all optional; per-backend defaults fill gaps):
  - `commit` — record a change at all (git commit / p4 pending-or-submit / none no-op).
  - `isolate` — isolate parallel workers (git worktree / p4 temp client / shared tree).
  - `publish` — share the change (git push / p4 submit / none no-op).
  - `openReview` — open a review (gh pr create / p4 swarm / none no-op).
  - `branchPerRun` — start each loop run on a fresh branch (git only; ignored elsewhere).
    Branch name: `tasks/run-<run-id>`; created from the current integration tip at run start;
    `publish` pushes that branch; the branch is left in place at run end (cleanup is the
    operator's call, not the adapter's).
- `ignore` (optional, none-backend only): array of gitignore-style globs excluded from the
  none-mode baseline manifest (§5.5), in addition to the built-in exclusions. Default:
  `["node_modules/", "dist/", ".git/", "*.log"]`.

Validated with Zod (mirrors the existing `src/config/env.ts` style). Unknown keys rejected
(`.strict()`); `version` must be `1`. An invalid or unparseable `.tasks/scm.json` is a **hard
config error** (CLI exit 2, §4.1) — it never silently falls through to auto-detect, because a
typo'd config silently reverting to git-auto would violate the user's stated preference.

`.tasks/scm.json` is committed. The adapter's **runtime state** lives in `.tasks/.scm/`
(baseline manifests, temp-client records, per-context scratch) — that directory is added to
the central exclusion list (§4.4) and MUST never be staged or committed by any backend.

### 3.2 Resolution precedence

1. `.tasks/scm.json` at the repo root (authoritative).
2. Project charter `scm` field in the tasks DB (default-only fallback; see §6.3).
3. **Auto-detect** (also what `backend: "auto"` triggers):
   - `.git/` present → `git`
   - `.p4config` / `$P4CONFIG` / `.p4` present → `perforce`
   - otherwise → `none`

Precedence clarifications (all resolvable ambiguities are decided here, not at implementation
time):

- **"Repo root" is found by walking up from the CLI's cwd** to the nearest directory containing
  `.tasks/scm.json`, else the nearest SCM marker (`.git`, `.p4config`). Every verb also accepts
  an explicit `--repo <path>` override — required for cross-repo runs (§4.5).
- **The charter fallback is per-project; backend is per-repo** (the spec's own rationale for
  §2.3). Therefore the charter `scm` field supplies **behavior-toggle defaults and a backend
  hint only for repos with no `.tasks/scm.json` AND no detectable marker**. If the charter
  names a backend that contradicts a strong on-disk marker (charter says `perforce` but the
  repo has `.git` and no `.p4config`), the marker wins and the adapter emits a one-line
  `warnings[]` entry (§4.1) naming the conflict. The charter never overrides an on-disk signal.
- **Both `.git` and `.p4config` present** (e.g. a p4 workspace with a vendored git checkout, or
  a git repo tracked in p4): auto-detect resolves to `perforce` only when the `.p4config` is at
  the repo root being resolved; a marker found *above* the walk-up root is ignored. If both
  markers are at the same root, auto-detect refuses (exit 2) and demands an explicit
  `.tasks/scm.json` — guessing here is how a submit ends up in the wrong system.

### 3.3 Per-backend behavior defaults (when `behaviors` omitted)

| behavior | git | perforce | none |
|---|---|---|---|
| commit | on | on | off |
| isolate | on (worktree) | shared-tree-serialized¹ | off (shared) |
| publish | on | on | off |
| openReview | off | off | off |
| branchPerRun | off | off | off |

¹ perforce `isolate` requires a temp-client template to be configured; without it the loop
runs shared-tree-serialized (see §5.2).

## 4. Adapter verb contract

The CLI exposes one verb per SCM primitive the skills need. Each verb is a pure function of
(backend, behaviors, args) and prints machine-readable output per the wire contract in §4.1.
All verbs accept two global flags: `--repo <path>` (resolution root override, §3.2) and
`--context <id>` (a caller-chosen scope key — task id or isolation id — that namespaces
per-run state: none-mode baselines, perforce numbered changelists, temp-client names).
`--context` defaults to `"default"`; parallel orchestrators MUST pass distinct contexts.

| Verb | git | perforce | none |
|---|---|---|---|
| `detect` | resolved backend + source + capabilities (§4.1) | " | " |
| `baseline` | `git rev-parse HEAD` | highest submitted CL visible to the client (`p4 changes -m1 -s submitted //...#have`) | manifest digest → `.tasks/.scm/<context>/baseline.json` (§5.5) |
| `status` | `git status --porcelain` | `p4 opened` + `p4 status` | manifest compare |
| `changed-files <base>` | `git diff --name-only <base>..HEAD` | `p4 opened -c <ctx CL>` / `p4 describe -s <cl>` | filesystem diff vs baseline manifest |
| `stage <files…>` | `git add <files>` (never `-A`/`.`) | `p4 edit`/`add`/`reconcile <files>` into the context's numbered pending CL (never the default CL) | no-op |
| `record -m <msg>` | `git commit -m` | pending/shelved CL, or `p4 submit` if `publish` on (§4.2) | no-op |
| `change-id` | `git rev-parse HEAD` | the context's CL number — **post-renumber if submitted** (§4.3) | empty `ids: []` |
| `publish` | `git push` (`--set-upstream origin` fallback; no remote → `NO_REMOTE` error, §4.1) | `p4 submit` of the context CL (§4.3) | no-op |
| `open-review` | `gh pr create` (missing `gh` → clean skip + warning) | `p4 shelve` + swarm (or clean skip) | no-op |
| `isolate <id>` | **capability report only** — see note below | provision temp p4 client from template, else report `serialized` | report `shared` |
| `teardown-isolation <id>` | remove/prune only worktrees recorded in `.tasks/.scm/<context>/` — never sweep `.claude/worktrees/*` wholesale | delete the temp client recorded for `<id>`; revert its opened files first | no-op |
| `reset-hard <ref>` | `git reset --hard <ref>` | `p4 revert -a` + `p4 sync @<cl>` | **unsupported** — exit 4 (§4.1); the manifest is digest-only and cannot restore content |

**`isolate` is asymmetric by necessity.** For git, isolation is provided by the Claude Code
platform harness (`isolation:"worktree"` on the Agent call) — a CLI subprocess *cannot* request
it. So `scm isolate` for git does not create anything; it reports
`{ "strategy": "platform-worktree" }` and the **orchestrator skill** is responsible for setting
`isolation:"worktree"` on the Agent dispatch. For perforce, the adapter genuinely provisions
(temp client); for none it reports `shared`. Skills consult `scm detect`'s `capabilities.isolation`
once up front (§5.2) rather than calling `isolate` per worker for git.

### 4.1 Wire contract — output schema + exit codes

Every verb prints **exactly one JSON object on stdout** (single line, UTF-8); human-readable
detail goes to stderr only. Envelope:

```json
{ "ok": true, "verb": "changed-files", "backend": "git", "context": "task-1421",
  "data": { }, "warnings": [] }
```

On failure `ok` is `false` and `data` is replaced by
`"error": { "code": "<STABLE_CODE>", "message": "...", "hint": "..." }`. Stable error codes
(minimum set): `CONFIG_INVALID`, `BACKEND_UNAVAILABLE`, `AUTH_EXPIRED`, `NO_REMOTE`,
`SUBMIT_CONFLICT`, `UNSUPPORTED_VERB`, `TIMEOUT`, `DIRTY_TREE`, `DETACHED_HEAD`.

**Exit codes (convention, enforced by tests):**

| Exit | Meaning | Retryable? |
|---|---|---|
| 0 | success — **including empty results** (`changed-files` with nothing changed returns `{ "files": [] }`, exit 0; `record` with nothing staged returns `{ "recorded": false, "changeId": null }`, exit 0) | — |
| 1 | SCM operation failed (push rejected, submit conflict, merge needed) | after remediation |
| 2 | usage / config error (unknown verb, invalid `.tasks/scm.json`, ambiguous auto-detect) | no — fix config |
| 3 | backend unavailable (p4 server unreachable, `p4 login` ticket expired, `git`/`p4` binary missing) | yes, after recovery |
| 4 | verb unsupported for this backend/toggle combination (e.g. none-mode `reset-hard`) | never |
| 124 | inner command exceeded the exec timeout (§6.1) | maybe |

Skills treat exit ≥1 as "stop and surface" — no verb failure is ever silently swallowed, and no
skill retries exit 2/4.

**Per-verb `data` shapes (normative):**

- `detect` → `{ "backend", "source": "file"|"charter"|"auto", "behaviors": {…}, "capabilities": { "isolation": "platform-worktree"|"p4-client"|"serialized"|"shared" } }`
- `baseline` → `{ "id": "<sha | p4:<cl> | none:<digest>>", "manifestPath": "<none only>" }`
- `status` → `{ "dirty": bool, "entries": [{ "path", "state" }] }`
- `changed-files` → `{ "base", "files": [{ "path", "change": "added"|"modified"|"deleted" }] }`
- `record` → `{ "recorded": bool, "changeId": string|null, "mode": "commit"|"submit"|"shelve"|"noop" }`
- `change-id` → `{ "ids": [string] }`
- `publish` → `{ "published": bool, "changeId": string|null }` (perforce: the **final, renumbered** CL)
- `isolate` → `{ "strategy", "path": "<scratch dir, p4 only>", "client": "<p4 client name>" }`

**Path encoding.** All file paths in inputs and outputs are repo-root-relative with forward
slashes, carried as discrete JSON strings / discrete argv entries. There is **no shell-string
quoting layer anywhere** — spaces, quotes, and unicode in filenames are safe by construction
(§6.1). Paths are normalized before the exclusion check (§4.4) so `./foo`, `foo`, and
`a/../foo` cannot dodge it; any staged path resolving outside the repo root is rejected
(exit 2).

**Git preflight edge cases (decided here):** `record` on a detached HEAD succeeds but emits a
`warnings[]` entry (publish from detached HEAD will fail — surface early). `publish` with no
upstream sets `--set-upstream origin <branch>`; with no `origin` remote it fails
`NO_REMOTE`/exit 1 and the orchestrator downgrades to record-only **with a loud per-run
warning** (mirror of the missing-`gh` policy). Shallow clones: `changed-files <base>` where
`<base>` is outside the shallow history fails exit 1 with a `hint` to deepen — never silently
diffs against the wrong base. Submodules: v1 treats a dirty submodule pointer as an ordinary
modified path; verbs never recurse into submodules.

**Perforce preflight:** every p4 verb first probes the session (`p4 login -s` semantics). An
expired ticket or unreachable server maps to `AUTH_EXPIRED`/`BACKEND_UNAVAILABLE`, exit 3 —
the adapter NEVER prompts interactively (it runs inside non-interactive agent turns) and never
reads or echoes `P4PASSWD`.

### 4.2 Perforce semantic collapse (load-bearing)

In perforce, *commit = submit = publish* is a
single act — there is no local-commit-then-push. The adapter normalizes the skills' universal
`record → publish` sequence:

- `commit` on + `publish` on → `p4 submit`.
- `commit` on + `publish` off → keep a **shelved / pending changelist** (recorded, unpublished).
- `commit` off → reconcile-only, no submit.

This keeps skill prose backend-neutral: skills always "record, then publish"; the adapter maps
that onto whatever the backend's model actually is.

**Renumbering (evidence-critical).** `p4 submit` renumbers the pending changelist — pending CL
123 becomes submitted CL 456. Evidence captured from a *pending* CL number is therefore wrong
the moment publish runs. Rule: when `publish` is on, `change-id` / evidence capture happens
**after** `publish` returns, using the final CL number from the submit output (which the
adapter parses and returns in `publish.data.changeId`). When `publish` is off, the shelved CL
number is the durable id (shelving does not renumber). Skills never quote a pending CL number
as evidence in a publish-on run.

### 4.3 Perforce failure modes

- **Submit conflict (files out of date).** `p4 submit` refuses when depot files changed under
  the opened set. v1 policy: the adapter runs `p4 sync` + `p4 resolve -as` (accept-safe,
  automatic merges only) and retries the submit **once**. Any remaining conflict →
  `SUBMIT_CONFLICT`, exit 1, files left opened in the numbered CL for a human — the adapter
  never runs `-at`/`-ay` (accept-theirs/yours) and never reverts a conflicted CL on its own.
- **Partial submit state.** A failed submit leaves the CL pending with files still open; the
  adapter reports the CL number in the error payload so nothing is orphaned invisibly.
- **Concurrent workers.** Each `--context` gets its own numbered pending changelist (created
  lazily on first `stage`), so two workers in one client cannot cross-contaminate the default
  changelist. Temp-client isolation (§5.2) is still the real fix for parallel runs; numbered
  CLs are the floor, not the ceiling.
- **Session/offline.** Covered by the §4.1 preflight — every failure surfaces as exit 3 with a
  stable code; no verb half-runs against a dead server.

### 4.4 Exclusion invariant

The repo's "never stage `.planning/` artifacts (LOOP-RUN.md,
AUDIT.md, DECOMPOSITION.md), never modify `.gitignore`, never commit `data/*.db`, `.env`,
`/bin`" rule moves into a central `exclusions.ts` the adapter consults for every `stage`/`record`
across all backends — enforced in code, not restated per skill. `.tasks/.scm/` (adapter runtime
state, §3.1) joins the list. The check runs on **normalized repo-relative paths** (§4.1) so
path games cannot bypass it, and a `stage` call containing an excluded path fails the whole
call (exit 2, listing the offenders) rather than silently dropping them — a skill that tries to
stage `LOOP-RUN.md` has a bug worth surfacing, not papering over.

### 4.5 Mixed-backend cross-repo runs

A tasks-project can span repos, and those repos can use different backends (one git, one
perforce, one bare directory). Because config is per-repo (§2.3) this composes, but the
composition rules must be explicit:

- **Resolution is per-repo, always.** Every verb call is scoped by `--repo` (or cwd walk-up);
  there is no run-global backend. A loop touching two repos issues two `detect`s and carries
  two `(backend, behaviors)` tuples.
- **Evidence namespacing.** `commit_shas` entries stay bare SHAs for git (backward-compat with
  every existing consumer); perforce contributes `p4:<cl>` entries; none contributes nothing.
  The anti-fabrication hook (§5.3) dispatches on shape: bare 40/7-hex → validate as git SHA,
  `p4:` prefix → validate CL existence, empty → none-mode pass.
- **Isolation capability is the MIN across touched repos.** A task whose file set spans a git
  repo and a p4 repo cannot be worktree-isolated (the platform worktree only covers the git
  side). The loop-dag orchestrator computes per-task capability as the minimum of the touched
  repos' `capabilities.isolation` and serializes tasks that don't meet the wave's isolation
  bar (§5.2). In practice: mixed-backend tasks run serialized; single-repo tasks keep full
  parallelism.
- **`record`/`publish` are not transactional across repos.** A run that records in repo A and
  fails to publish in repo B leaves A published — the orchestrator reports per-repo outcomes
  separately in the close-out comment and never claims run-level atomicity.

## 5. Verification & isolation

### 5.1 Evidence envelope generalization

The `VerifierInputs` / `verification_evidence` contract (`loop-shared.md` §B) currently carries
git-specific fields. They generalize:

- `commit_shas` → conceptually **`change-ids`**: git SHAs (bare, unchanged wire shape),
  perforce changelist numbers as `p4:<cl>` (post-renumber, §4.2), or **empty** for none.
  (Keep the wire field name for backward-compat; populate from `scm change-id` /
  `scm publish` output — see §4.5 for the namespacing rule.)
- `file_changes` ← `scm changed-files` (`data.files[].path`).
- `base_sha` ← `scm baseline` (`data.id`; for none this is the `none:<digest>` manifest id,
  which the verifier can re-derive from the same manifest to assert the base, mirroring the
  git base-integrity check).

The §B escape hatch already accepts empty arrays and a `NOT_VERIFIED` path, so **none-mode is a
legitimate state, not fabrication**. In none-mode, verification leans on `changed-files`
(filesystem diff vs the baseline manifest) plus the worker's per-AC evidence map — exactly the
non-SHA evidence the verifier already knows how to grade.

### 5.2 Platform worktree constraint (load-bearing)

The Claude Code Agent-tool `isolation:"worktree"` uses **git worktrees**, is chosen by the
platform harness, and has **no in-repo code locus** (documented at `loop-dag.md:161`). Therefore:

- **git + `isolate` on** → request platform worktree isolation (unchanged from today).
- **perforce + `isolate` on** → the adapter provisions a temp p4 client mapped to a scratch dir
  (real p4 isolation). If no client template is configured, **degrade to shared-tree-serialized**.
- **perforce/none + `isolate` off** → always shared tree.

**Consequence for `/tasks:loop-dag` (parallel):** it MUST NOT request a git worktree in a
perforce or none tree. The orchestrator resolves `scm detect` + `isolate` capability up front and
either (a) uses git worktrees, (b) uses p4 temp clients, or (c) **downgrades to serialized
execution**. No silent creation of a git worktree in a non-git tree.

**The downgrade path, fully specified:** when `capabilities.isolation` is `serialized` or
`shared` (or the per-task MIN across repos is, §4.5), the orchestrator (1) forces effective
`--concurrency 1` for the affected tasks regardless of the flag the user passed, (2) records
the downgrade in LOOP-RUN.md ("isolation downgraded: <reason>") and echoes it as the run's
first status line so the operator sees it *before* the first dispatch, not in the post-mortem,
(3) still recomputes the frontier wave-by-wave — the DAG ordering survives, only intra-wave
parallelism is lost, and (4) treats serialization as mandatory, not advisory (the documented
loop-dag shared-tree hazard: even disjoint file sets can stomp each other in a shared tree,
and in p4/none there is no worktree backstop at all). A user who
wants true perforce parallelism configures the temp-client template; there is no third option.

### 5.3 Anti-fabrication hook

The client-side SHA-validation hook referenced in `loop-shared.md` §L (blocks non-existent git
SHAs) becomes **backend-aware**, dispatching on value shape per §4.5: bare hex → git SHA
existence check, `p4:<cl>` → changelist existence check, empty array → none-mode pass (already
a legitimate §B state). **Locating the hook (its install path, whether it lives in `~/.claude`
hooks or the repo) is an explicit P1 deliverable** — P2 cannot "adapt" a hook nobody has pinned
down, and an unlocated hook that keeps hard-rejecting non-SHA values would brick every perforce
run at the evidence step.

### 5.4 Identity resolution (unchanged, extended)

Skills resolve author identity from `git config user.email` → `$USER` →
`claude-<model>-<purpose>`. This is a **read-only identity source independent of SCM** and is
retained in all modes. For perforce repos, `p4 info` (User name) is added as a source ahead of
`$USER`. none-mode keeps the git-config read as a best-effort fallback (a repo may have git
present even when SCM is "none").

### 5.5 none-mode baseline manifest (normative)

The none adapter's `baseline`/`status`/`changed-files` rest on a **digest manifest**, not a
content snapshot. Spec:

- **Location:** `.tasks/.scm/<context>/baseline.json` — per-`--context`, so concurrent runs
  (or a run and a stray manual invocation) never stomp one shared file.
- **Walk:** from the repo root, excluding `.tasks/.scm/`, the central exclusion list (§4.4),
  and the configured `ignore` globs (§3.1). If a `.git` directory happens to exist (git present
  but SCM "none"), it is excluded too.
- **Per-file record:** `{ path, size, mtimeMs, sha256 }`. Comparison fast-path: size+mtime
  match → assume unchanged (no re-hash); size or mtime differ → re-hash to confirm (editors
  that rewrite identical bytes don't produce false positives). Binary files are hashed like any
  bytes — no text/binary distinction. **Symlinks:** record the link target string, never
  follow (following can escape the repo root and loop).
- **Manifest id:** `none:<sha256-of-canonical-manifest>` — this is what `baseline` returns and
  what lands in `base_sha`, letting the verifier re-derive and assert the base (§5.1).
- **Performance envelope:** the walk streams (no full-tree buffering); the size+mtime fast
  path means steady-state `changed-files` re-hashes only touched files. Budget: a 50k-file
  tree completes `status` in single-digit seconds on local disk; the P1 test suite pins a
  generated-tree benchmark so a regression is a test failure, not a discovery in someone's
  monorepo.
- **What it cannot do:** restore content. `reset-hard` is unsupported in none mode (exit 4,
  §4.1) — an earlier draft said "restore from snapshot", which a digest manifest cannot honor;
  claiming it could would fabricate a recovery path. Failure recovery in none mode is manual,
  and the orchestrator must say so when it happens.

## 6. Implementation surface

### 6.1 New `src/scm/` module

- `types.ts` — `SCMAdapter` interface (one method per verb), `SCMConfig`, `Backend`.
- `git-adapter.ts` — behavior parity with today's prose, byte-for-byte.
- `perforce-adapter.ts` — p4 semantics + collapse rules.
- `none-adapter.ts` — no-ops + filesystem baseline/diff.
- `resolve-config.ts` — precedence in §3.2.
- `detect.ts` — auto-detection.
- `exclusions.ts` — central staging exclusion list (§4.4 invariant).
- `exec.ts` — the repo's **first** `child_process` wrapper; safety contract below.

#### `exec.ts` safety contract

This module is the only place in the repo that spawns a subprocess for SCM work; every adapter
goes through it. Because it is a new attack/bug surface, its contract is pinned here:

- **argv-array only** — `execFile`-style invocation, `shell: false`, no string interpolation
  ever. There is no code path that concatenates user- or model-supplied text into a shell
  string; commit messages, branch names, and file paths ride as discrete argv entries.
- **Binary allowlist** — only `git`, `p4`, and `gh` may be spawned; the binary name is a
  literal in each adapter, never data. Resolution uses PATH but the wrapper rejects any argv[0]
  containing a path separator.
- **cwd pinned** to the resolved repo root (§3.2) for every call; no adapter runs a command
  from an unpinned inherited cwd.
- **Timeouts** — default 60s per command, overridable per call-site (submit/push get 300s);
  on expiry the child gets SIGTERM then SIGKILL after 5s, and the verb exits 124 with a
  `TIMEOUT` error payload (§4.1).
- **Output caps** — stdout/stderr capture is bounded (default 10 MB); an overflowing command
  fails cleanly rather than OOMing the CLI.
- **Env hygiene** — the child env is the parent env minus a denylist (`P4PASSWD` is never
  logged and never echoed into error payloads; error messages are scrubbed for `P4PASSWD=`
  patterns before they leave the wrapper). No env var is ever interpolated into argv.
- **Non-interactive guarantee** — stdin is closed/`ignore`; a command that prompts (p4 login,
  git credential helper) hits the timeout instead of hanging the loop, and the §4.1 preflights
  exist to catch those cases before they occur.
- **Tested first** — `exec.ts` lands in P1 with its own unit tests (timeout kill escalation,
  output cap, argv passthrough of hostile filenames like `$(rm -rf).txt` and `--not-a-flag`,
  env scrubbing) before any adapter builds on it.

Filenames that begin with `-` are protected positionally: every adapter terminates option
parsing with `--` before file arguments where the underlying tool supports it (`git add --`,
`git diff --`), which is also how today's prose-driven git usage should have behaved.

### 6.2 CLI

`tasks scm <verb> [args]` wired into the existing CLI (`src/cli/`). Verbs print machine-readable
output where a downstream skill consumes a value.

### 6.3 Config carrier

- `.tasks/scm.json` reader + Zod validator.
- Optional DB migration adding an `scm` default to the project charter (alongside
  `src/db/migrations/014-value-charter.ts`), surfaced on the `get_project` MCP tool — the
  precedence-2 fallback only.

### 6.4 Skill rewrites (source `skills/`, then `npm run build:skills`)

- `loop.md` — Step 6 commit/push, pre-flight status, evidence capture → verbs.
- `loop-dag.md` — worktree mandate → capability-gated `isolate`; per-task record.
- `loop-shared.md` — §A brief template, §B envelope, §N worktree teardown, §Q patch integration.
- `tasks-verifier.md` + `integration-auditor.md` — the read-only-git allow-lists become
  read-only-**scm** (git read verbs / p4 read verbs / none).

**Version-skew guard (skills ↔ CLI).** Skills are synced into `~/.claude` by self-update and
can outrun (or lag) the installed CLI. A P2 skill that calls `tasks scm` against a pre-SCM CLI
must fail loudly, not quietly regress: each migrated skill runs `tasks scm detect` **once at
run start** and, if the verb is missing (unknown-command error), aborts with an explicit
"upgrade wood-fired-tasks CLI" message. It NEVER falls back to raw git prose — a silent
fallback would resurrect exactly the drift the adapter exists to kill, and would bypass the
exclusion invariant (§4.4).

### 6.5 Guards & docs

- Extend `interfaces-counts.test.ts` file lists (known drift blind-spot: new tool/module files
  dodge the doc-drift guard unless added).
- New `docs/SCM.md` contract; update `AGENTS.md` navigation.
- `CHANGELOG.md` entry.
- Rebuild `dist/skills/` (never edit `dist/` directly).

## 7. Phasing

Each phase keeps git behavior green end-to-end; SCM is opt-in.

1. **P1 — Abstraction + git/none parity.** Config schema/resolver/detect, `SCMAdapter`
   interface, git adapter (parity), none adapter, CLI verbs + wire contract (§4.1), `exec.ts`
   (+ its safety tests), unit tests, and **locating the §L SHA-validation hook** (path +
   ownership documented; adaptation itself is P2). No skill changes yet; git loop unchanged.
2. **P2 — Skill migration.** Rewrite skills to call verbs; generalize the evidence envelope;
   make the anti-fabrication hook backend-aware; update verifier/auditor allow-lists; rebuild
   dist. Git behavior byte-identical; none-mode functional end-to-end.
3. **P3 — Perforce adapter.** submit/reconcile/opened/describe, changelist evidence
   (post-renumber capture, §4.2), submit-conflict policy (§4.3), client-isolation with the
   §5.2 serialized fallback, `p4 info` identity, session preflight, tests.
4. **P4 — Docs, drift-guard lists, charter migration, examples, CHANGELOG.**

Given the size, each phase is expected to become its own spec→plan→implement cycle; this spec is
the shared contract they all reference.

## 8. Testing strategy

- **Adapter unit tests** per backend against a mocked `exec` (assert exact argv per verb, incl.
  the `never git add -A` rule, `--` option-termination before file args, and the exclusion
  list — including the normalized-path bypass attempts from §4.1/§4.4).
- **`exec.ts` unit tests** — timeout SIGTERM→SIGKILL escalation, output cap, hostile-filename
  argv passthrough (`$(…)`, leading `-`, spaces/unicode), env scrubbing of `P4PASSWD`,
  binary-allowlist rejection.
- **Wire-contract tests** — every verb's JSON shape validates against the §4.1 schemas; exit
  codes match the table (incl. empty-result-is-exit-0 for `changed-files`/`record`, exit 4 for
  none-mode `reset-hard`, exit 2 for invalid config and ambiguous dual-marker auto-detect).
- **Config resolution tests** — file > charter > auto-detect, `backend:"auto"`, invalid file
  rejected (exit 2, not silent fallback), charter-vs-marker conflict warns with marker winning,
  `--repo` override, cwd walk-up.
- **none-mode evidence path** — empty `change-ids` accepted; filesystem-diff `changed-files`;
  verifier grades without SHAs; manifest handles symlinks/binary/mtime-rewrite cases; the §5.5
  generated-tree performance benchmark; two `--context`s don't stomp each other's baselines.
- **Perforce semantic-collapse tests** — the three `commit`/`publish` combinations map to
  submit / shelve / reconcile-only; **renumber capture** (pending CL ≠ submitted CL, evidence
  carries the final number); submit-conflict → safe-resolve-retry-once → `SUBMIT_CONFLICT`;
  expired-ticket and unreachable-server map to exit 3 without hanging.
- **Mixed-backend tests** — two-repo fixture (git + none) resolves per-repo, evidence
  namespacing per §4.5, per-task isolation MIN computed correctly.
- **Perforce integration** — default runs against a **mock p4**; an optional real-`p4d`
  integration is gated by an env flag (mirrors the existing `WFG_TESTS_REAL` pattern).
- **Skill version-skew** — a migrated skill against a CLI without `scm` aborts with the
  upgrade message (§6.4), never falls back to raw git.
- Zero-tolerance: build + full suite stay green at every phase boundary.

## 9. Codebase reality (grounding facts from the map)

- No direct git in `src/` or `packages/`; all coupling is skill prose + platform worktree.
- `packages/wft-router/` is vendor-neutral and has no SCM coupling — untouched.
- Skills read per-project settings only via MCP tools today; they infer build/test commands
  heuristically. Precedent exists (`loop-shared.md:808`) for "explicit project config wins over
  heuristic" — the `.tasks/scm.json` + auto-detect design follows the same shape.
- Primary files to touch, ranked: `loop.md`, `loop-shared.md`, `loop-dag.md`,
  `tasks-verifier.md`, `integration-auditor.md`, then the new `src/scm/` + config carrier.

## 10. Open risks (non-blocking; decided during implementation)

- **Perforce parallel isolation** is the hardest piece. v1 fallback = the fully-specified
  §5.2 downgrade (forced serialization, loud up-front warning) when no temp-client template is
  configured. The temp-client template format itself (client-spec fields, view mapping,
  scratch-dir layout) is P3 design work — the only v1 commitment is that provisioning is
  adapter-owned and torn down by `teardown-isolation`.
- **`gh` availability** for `open-review` — keep `openReview` default-off; treat a missing `gh`
  as a clean skip, not a failure. Same policy for a git repo with no remote on `publish`
  (§4.1): downgrade to record-only, loudly.
- **Skill/CLI version skew** — mitigated by the §6.4 run-start `scm detect` preflight; residual
  risk is a user pinning an old CLI indefinitely, which fails loud, not wrong.
- **Backward compatibility** — repos with no `.tasks/scm.json` auto-detect to git and behave
  exactly as today; P2's git adapter output feeds the same `commit_shas`/`file_changes` wire
  fields with the same bare-SHA values, so existing verifiers, the §L hook, and stored evidence
  rows are unaffected. The whole feature is opt-in.
- **none-mode recovery is manual** (§5.5) — accepted for v1; a content-snapshot toggle could
  restore `reset-hard` later but is out of scope (cost: full-tree copies per baseline).
