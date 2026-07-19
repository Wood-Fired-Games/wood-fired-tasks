# Pluggable Source Control (SCM)

Agents: start at [`AGENTS.md`](../AGENTS.md); the full read-order contract is in [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md).

Reference for the pluggable source-control layer that lets a repo use **git**,
**perforce**, or **none** without any skill or tool hard-coding git. The
normative contract is the design spec at
[`docs/superpowers/specs/2026-07-16-pluggable-scm-design.md`](superpowers/specs/2026-07-16-pluggable-scm-design.md);
this page is the operator- and agent-facing summary of what shipped.

## Overview

Every source-control action funnels through **one adapter CLI**:
`tasks scm <verb>`. Skills and tooling call verbs; the CLI resolves the
configured backend for the repo and dispatches to it, honoring per-repo
behavior toggles. This is the only SCM chokepoint — branching "3 backends ×
many git verbs" through prose in every skill would drift and depend on model
compliance, so it does not exist. All three backends are first-class:

| Backend | Meaning |
|---|---|
| `git` | Byte-for-byte parity with the prior git-only behavior (`add`/`commit`/`push`/`diff`/`rev-parse`). |
| `perforce` | p4 semantics — `commit = submit = publish` collapses to a single act; numbered pending changelists per context. |
| `none` | Perform no version-control operations at all; the task loop still functions via a filesystem **digest manifest** — a per-file `{ path, size, mtimeMs, sha256 }` fingerprint record, not a content snapshot, used to baseline and verify by diffing two manifests (see [§ none](#none-1) below for the full shape). |

Backend selection is a per-**repo** property (a single tasks-project can span
multiple repos), so config lives with the repo — not the project or the DB.

## Quickstart

### git

Zero config: do nothing — behavior is unchanged. With no `.tasks/scm.json`,
auto-detect finds `.git` and resolves the `git` backend (`source: "auto"`).

```
$ tasks scm detect --repo .
{"ok":true,"verb":"detect","backend":"git","context":"default","data":{"backend":"git","source":"auto","behaviors":{"commit":true,"isolate":true,"publish":true,"openReview":false,"branchPerRun":false},"capabilities":{"isolation":"platform-worktree"}},"warnings":[]}
```

### perforce (experimental)

Log in once so the non-interactive adapter has a valid ticket — it never
prompts: `p4 login`. Then opt the repo in with a minimal
`.tasks/scm.json`:

```json
{ "version": 1, "backend": "perforce" }
```

Requires a p4 client **2021.1+** (the adapter's form-edit flow depends on the
`--field` global option, introduced in that release). In v1, perforce loops
always run **serialized** — there is no temp-client isolation yet
(`capabilities.isolation` is unconditionally `"serialized"`); parallel
orchestrators must not assume per-worker isolation while this backend is
experimental.

A real-server integration suite already exists
(`src/scm/__tests__/perforce-real-p4d.test.ts`) and drives the production
adapter against a real dockerized `p4d`, gated by `WFG_TESTS_REAL_P4=1` (see
[below](#wfg_tests_real_p4-real-p4d-suite)). It is not yet wired into CI.
**Graduation criterion:** the real-p4d suite runs green in CI (not just
locally on demand) — until then this backend stays labeled experimental.

```
$ tasks scm detect --repo .
{"ok":true,"verb":"detect","backend":"perforce","context":"default","data":{"backend":"perforce","source":"file","behaviors":{"commit":true,"isolate":false,"publish":true,"openReview":false,"branchPerRun":false},"capabilities":{"isolation":"serialized"}},"warnings":[]}
```

### none

No `.tasks/scm.json` and no `.git`/`.p4config` marker falls back to `none`
(`source: "auto"`). Runtime state lives under `.tasks/.scm/<context>/` —
per-context digest manifests (`baseline.json`) used for baseline/diff
verification — and is never committed. Tune the `ignore` globs in
`.tasks/scm.json` if baseline-churn false positives show up (build output,
scratch files). **No-undo caveat:** `reset-hard` is unsupported (exit 4) —
a digest-only manifest cannot restore content, so recovery is manual; see
[§ Recovery in none-mode](#recovery-in-none-mode) below.

```
$ tasks scm detect --repo .
{"ok":true,"verb":"detect","backend":"none","context":"default","data":{"backend":"none","source":"auto","behaviors":{"commit":false,"isolate":false,"publish":false,"openReview":false,"branchPerRun":false},"capabilities":{"isolation":"shared"}},"warnings":[]}
```

## Configuration — `.tasks/scm.json`

A committed, repo-local JSON file. The adapter reads it off the filesystem with
no DB round-trip.

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

- **`version`** — must be `1`.
- **`backend`** — `"git" | "perforce" | "none" | "auto"`.
- **`behaviors`** (all optional; per-backend defaults fill any gaps):
  - `commit` — record a change at all (git commit / p4 pending-or-submit / none no-op).
  - `isolate` — isolate parallel workers (git worktree / p4 temp client / shared tree).
  - `publish` — share the change (git push / p4 submit / none no-op).
  - `openReview` — open a review (`gh pr create` / p4 swarm / none no-op).
  - `branchPerRun` — **reserved — rejected in v1.** Setting `branchPerRun: true`
    fails `.tasks/scm.json` schema validation (`CONFIG_INVALID`, exit 2) rather
    than silently no-opping; omit it or set it to `false`. Design intent for a
    future version: start each loop run on a fresh branch (git only), named
    `tasks/run-<run-id>`, created from the current integration tip at run
    start; `publish` pushes it; the branch is left in place at run end.
- **`ignore`** (optional, none-backend only) — gitignore-style globs excluded from
  the none-mode baseline manifest, in addition to the built-in exclusions.
  Default: `["node_modules/", "dist/", ".git/", "*.log"]`.

The file is validated with Zod, **`.strict()`** (unknown keys rejected). An
invalid or unparseable `.tasks/scm.json` is a **hard config error** (CLI exit 2)
— it never silently falls through to auto-detect, because a typo'd config
reverting to git-auto would violate the user's stated preference.

`.tasks/scm.json` is committed. The adapter's **runtime state** lives in
`.tasks/.scm/` (baseline manifests, temp-client records, per-context scratch);
that directory is on the central exclusion list and is never staged or committed
by any backend.

### Resolution precedence

This is the **single canonical statement** of the resolution order — README
and SETUP.md link here rather than restating it. The effective backend is
resolved once per repo by trying these four sources in order; first match
wins:

1. **`.tasks/scm.json`** at the repo root, with a concrete `backend` (not
   `"auto"`) — authoritative (`source: "file"`).
2. **On-disk marker** — `.git/` present → `git`; `.p4config` / `$P4CONFIG` /
   `.p4` present → `perforce` (`source: "auto"`). Tried when there is no
   config file, or `backend: "auto"`. A detected marker **beats the charter
   hint** below: if the charter names a different backend, the marker still
   wins and the adapter emits a `warnings[]` entry naming the conflict.
3. **Project charter `scm.backend` hint** in the tasks DB — a default-only
   fallback used **only** when there is no `.tasks/scm.json` and no on-disk
   marker (step 2 found nothing). Surfaced on the `get_project` MCP tool.
4. **`none`** — the final fallback when nothing above applies.

Clarifications:

- **Repo root** is found by walking up from the CLI's cwd to the nearest
  directory containing `.tasks/scm.json`, else the nearest SCM marker. Every verb
  accepts `--repo <path>` to override — required for cross-repo runs.
- **Both `.git` and `.p4config` at the same root** → auto-detect refuses (exit 2)
  and demands an explicit `.tasks/scm.json`; guessing here is how a submit lands
  in the wrong system.

### Per-backend behavior defaults (when `behaviors` omitted)

| behavior | git | perforce | none |
|---|---|---|---|
| commit | on | on | off |
| isolate | on (worktree) | shared-tree-serialized¹ | off (shared) |
| publish | on | on | off |
| openReview | off | off | off |
| branchPerRun | reserved — rejected in v1 | reserved — rejected in v1 | reserved — rejected in v1 |

¹ perforce `isolate` needs a temp-client template configured; without it the loop
runs shared-tree-serialized.

## Adapter verbs — `tasks scm <verb>`

One verb per SCM primitive the skills need. Each verb is a pure function of
(backend, behaviors, args). Two global flags apply to every verb:

- `--repo <path>` — resolution-root override (defaults to cwd walk-up).
- `--context <id>` — a caller-chosen scope key (task id / isolation id) that
  namespaces per-run state: none-mode baselines, perforce numbered changelists,
  temp-client names. Defaults to `"default"`; **parallel orchestrators MUST pass
  distinct contexts.**

Legend: each row is one verb; the `git`/`perforce`/`none` columns describe
what that verb does *for that backend* — read left-to-right per row, not as
alternatives to pick between.

| Verb | git | perforce | none |
|---|---|---|---|
| `detect` | resolved backend + source + capabilities | resolved backend + source + capabilities | resolved backend + source + capabilities |
| `baseline` | `git rev-parse HEAD` | highest submitted CL visible to the client | manifest digest → `.tasks/.scm/<context>/baseline.json` |
| `status` | `git status --porcelain` | `p4 opened` + `p4 status` | manifest compare |
| `changed-files <base>` | `git diff --name-status <base>..HEAD` | `p4 opened` / `p4 describe -s` | filesystem diff vs baseline manifest |
| `stage <files…>` | `git add <files>` (never `-A`/`.`) | `p4 edit`/`add`/`reconcile` into the context's numbered pending CL | no-op |
| `record <msg>` | `git commit -m` | pending/shelved CL, or `p4 submit` if `publish` on | no-op |
| `change-id` | `git rev-parse HEAD` | the context's CL number — **post-renumber if submitted** | empty `ids: []` |
| `publish` | `git push` (`--set-upstream origin` fallback; no remote → `NO_REMOTE`) | `p4 submit` of the context CL | no-op |
| `open-review` | `gh pr create` (missing `gh` → clean skip + warning) | `p4 shelve` + swarm (or clean skip) | no-op |
| `isolate <id>` | **capability report only** (see below) | provision temp p4 client from template, else report `serialized` | report `shared` |
| `teardown-isolation <id>` | no-op (git `isolate` provisions nothing — worktrees are platform-managed; teardown records/removes nothing and never sweeps `.claude/worktrees/*`) | delete the temp client for `<id>`; revert its opened files first | no-op |
| `reset-hard <ref>` | `git reset --hard <ref>` | `p4 revert //...` + `p4 sync @<cl>` | **unsupported** — exit 4 (digest-only manifest cannot restore content) |

**`isolate` is asymmetric by necessity.** For git, isolation is provided by the
Claude Code platform harness (`isolation:"worktree"` on the Agent call) — a CLI
subprocess *cannot* request it — so `scm isolate` for git creates nothing and
reports `{ "strategy": "platform-worktree" }`; the orchestrator skill is
responsible for setting `isolation:"worktree"` on the Agent dispatch. For
perforce the adapter genuinely provisions a temp client; for none it reports
`shared`. Skills consult `scm detect`'s `capabilities.isolation` once up front
rather than calling `isolate` per worker for git.

### Wire contract — output envelope + exit codes

Every verb prints **exactly one JSON object on stdout** (single line, UTF-8);
human-readable detail goes to stderr only.

```json
{ "ok": true, "verb": "changed-files", "backend": "git", "context": "task-1421",
  "data": { }, "warnings": [] }
```

On failure `ok` is `false` and `data` is replaced by
`"error": { "code": "<STABLE_CODE>", "message": "...", "hint": "..." }`.
Stable error codes: `CONFIG_INVALID`, `BACKEND_UNAVAILABLE`, `AUTH_EXPIRED`,
`NO_REMOTE`, `SUBMIT_CONFLICT`, `UNSUPPORTED_VERB`, `TIMEOUT`, `DIRTY_TREE`,
`DETACHED_HEAD`.

**Exit codes (enforced by tests):**

| Exit | Meaning | Retryable? |
|---|---|---|
| 0 | success — **including empty results** (`changed-files` with nothing changed → `{ "files": [] }`; `record` with nothing staged → `{ "recorded": false, "changeId": null }`) | — |
| 1 | SCM operation failed (push rejected, submit conflict, merge needed) | after remediation |
| 2 | usage / config error (unknown verb, invalid `.tasks/scm.json`, ambiguous auto-detect) | no — fix config |
| 3 | backend unavailable (p4 server unreachable, expired `p4 login` ticket, `git`/`p4` binary missing) | yes, after recovery |
| 4 | verb unsupported for this backend/toggle combination (e.g. none-mode `reset-hard`) | never |
| 124 | inner command exceeded the exec timeout | maybe |

Skills treat exit ≥1 as "stop and surface" — no verb failure is silently
swallowed, and no skill retries exit 2/4.

**Per-verb `data` shapes (normative):**

- `detect` → `{ "backend", "source": "file"|"charter"|"auto", "behaviors": {…}, "capabilities": { "isolation": "platform-worktree"|"p4-client"|"serialized"|"shared" } }`
- `baseline` → `{ "id": "<sha | p4:<cl> | none:<digest>>", "manifestPath": "<none only>" }`
- `status` → `{ "dirty": bool, "entries": [{ "path", "state" }] }`
- `changed-files` → `{ "base", "files": [{ "path", "change": "added"|"modified"|"deleted" }] }`
- `record` → `{ "recorded": bool, "changeId": string|null, "mode": "commit"|"submit"|"shelve"|"noop" }`
- `change-id` → `{ "ids": [string] }`
- `publish` → `{ "published": bool, "changeId": string|null }` (perforce: the **final, renumbered** CL)
- `isolate` → `{ "strategy", "path": "<scratch dir, p4 only>", "client": "<p4 client name>" }`

**Path encoding.** All file paths are repo-root-relative with forward slashes,
carried as discrete JSON strings / argv entries. There is **no shell-string
quoting layer anywhere** — spaces, quotes, and unicode in filenames are safe by
construction. Paths are normalized before the exclusion check, so `./foo`,
`foo`, and `a/../foo` cannot dodge it; any staged path resolving outside the repo
root is rejected (exit 2).

### Exclusion invariant

A central exclusion list is consulted for every `stage`/`record` across all
backends — enforced in code, not restated per skill. It covers `.planning/`
artifacts (LOOP-RUN.md, AUDIT.md, DECOMPOSITION.md), `.gitignore`, `data/*.db`,
`.env`, `/bin`, and the adapter's own `.tasks/.scm/` runtime state. The check
runs on normalized repo-relative paths, and a `stage` call containing an excluded
path fails the whole call (exit 2, listing offenders) rather than silently
dropping them.

## Backends

### git

Byte-for-byte parity with the prior prose-driven git behavior. `stage` is always
`git add <files>` — **never `-A`/`.`** Option parsing is terminated with `--`
before file arguments (`git add --`, `git diff --`) so filenames beginning with
`-` are safe.

Edge cases (decided normatively):

- `record` on a **detached HEAD** succeeds but emits a `warnings[]` entry (publish
  from detached HEAD will fail — surfaced early).
- `publish` with no upstream sets `--set-upstream origin <branch>`; with no
  `origin` remote it fails `NO_REMOTE`/exit 1 and the orchestrator downgrades to
  record-only **with a loud per-run warning** (same policy as missing `gh`).
- **Shallow clones:** `changed-files <base>` where `<base>` is outside the shallow
  history fails exit 1 with a `hint` to deepen — never silently diffs against the
  wrong base.
- **Submodules:** a dirty submodule pointer is treated as an ordinary modified
  path; verbs never recurse into submodules.

**Isolation:** provided by the Claude Code platform harness via git worktrees;
the adapter only reports the `platform-worktree` capability (see `isolate`).

**Evidence shape:** bare git SHAs, unchanged — populate `commit_shas` /
`change_ids` from `scm change-id` / `scm publish` (see [§ Verification &
isolation notes](#verification--isolation-notes) for the `change_ids` vs.
`commit_shas` spelling policy).

### perforce

In perforce, **commit = submit = publish** is a single act — there is no
local-commit-then-push. The adapter normalizes the skills' universal
`record → publish` sequence onto the p4 model:

- `commit` on + `publish` on → `p4 submit`.
- `commit` on + `publish` off → keep a **shelved / pending changelist** (recorded, unpublished).
- `commit` off → reconcile-only, no submit.

**Renumbering (evidence-critical).** `p4 submit` renumbers the pending
changelist (pending CL 123 → submitted CL 456). When `publish` is on, evidence
capture happens **after** `publish` returns, using the final CL number from the
submit output (returned in `publish.data.changeId`). When `publish` is off, the
shelved CL number is the durable id (shelving does not renumber). Skills never
quote a pending CL number as evidence in a publish-on run.

**Failure modes:**

- **Submit conflict (files out of date).** The adapter runs `p4 sync` +
  `p4 resolve -as` (accept-safe, automatic merges only) and retries the submit
  **once**. Any remaining conflict → `SUBMIT_CONFLICT`, exit 1, files left opened
  in the numbered CL for a human. The adapter never runs `-at`/`-ay` and never
  reverts a conflicted CL on its own.
- **Concurrent workers.** Each `--context` gets its own numbered pending
  changelist (created lazily on first `stage`), so two workers in one client
  cannot cross-contaminate the default changelist.
- **Session/offline.** Every p4 verb first probes the session (`p4 login -s`
  semantics). An expired ticket or unreachable server maps to
  `AUTH_EXPIRED`/`BACKEND_UNAVAILABLE`, exit 3. The adapter NEVER prompts
  interactively and never reads or echoes `P4PASSWD`.

**Isolation:** the adapter provisions a temp p4 client mapped to a scratch dir
(real isolation). Without a client template it degrades to **shared-tree
serialized** (the orchestrator forces `--concurrency 1` for affected tasks and
announces the downgrade up front).

**Evidence shape:** changelist numbers as `p4:<cl>` (post-renumber).

#### WFG_TESTS_REAL_P4 (real-p4d suite)

`WFG_TESTS_REAL_P4=1` gates
`src/scm/__tests__/perforce-real-p4d.test.ts` — an integration suite that
boots a real dockerized Helix Core (`p4d`) server and drives the production
`PerforceBackend` (real child processes, not the mocked `ExecScmFn` the rest
of the perforce test suite uses) through a full verb cycle.

- **What it gates:** the whole file, via `describe.skipIf`.
- **Prerequisites:** `docker` and a `p4` client binary on `PATH`, in addition
  to the env var.
- **Silent-skip semantics:** the suite is silently skipped (not failed) when
  `WFG_TESTS_REAL_P4` is unset (the default — `npm test` never needs Docker
  or a `p4` binary), or when it's set but `docker`/`p4` is missing from
  `PATH`.
- **Loud-failure semantics:** once `WFG_TESTS_REAL_P4` is set AND both
  binaries are present, a broken environment (image pull failure, readiness
  timeout, login failure) is a real failure, not a skip — the operator
  explicitly asked for it.
- **Run it:** `WFG_TESTS_REAL_P4=1 npx vitest run src/scm/__tests__/perforce-real-p4d.test.ts`.
- **Not yet CI-enforced** — see [§ perforce (experimental)](#perforce-experimental)
  for the graduation criterion.

### none

Perform **no** version-control operations, while the task loop still functions
via a **digest manifest** (not a content snapshot).

- **Location:** `.tasks/.scm/<context>/baseline.json` — per-`--context`, so
  concurrent runs never stomp one shared file.
- **Walk:** from the repo root, excluding `.tasks/.scm/`, the central exclusion
  list, the configured `ignore` globs, and any `.git/` directory that happens to
  exist.
- **Per-file record:** `{ path, size, mtimeMs, sha256 }`. Comparison fast-path:
  size+mtime match → assume unchanged (no re-hash); size or mtime differ →
  re-hash to confirm (so an editor that rewrites identical bytes produces no false
  positive). Binaries are hashed like any bytes. **Symlinks:** record the link
  target string, never follow (following can escape the repo root and loop).
- **Manifest id:** `none:<sha256-of-canonical-manifest>` — what `baseline`
  returns and what lands in `base_sha`, letting the verifier re-derive and assert
  the base.
- **`reset-hard` is unsupported** (exit 4): a digest manifest cannot restore
  content. Failure recovery in none mode is **manual**, and the orchestrator says
  so when it happens.

**Evidence shape:** empty `change_ids` — a legitimate verification state, not
fabrication. Verification leans on `changed-files` (filesystem diff vs the
baseline manifest) plus the worker's per-AC evidence map.

### Recovery in none-mode

**What reset-hard-unsupported means operationally.** The digest manifest
records **content identity** (per-file `{ path, size, mtimeMs, sha256 }`), not
**content** — there is nothing to restore *from*. `tasks scm reset-hard`
therefore exits `4` (`UNSUPPORTED_VERB`) in none-mode rather than attempting a
best-effort restore. There is **no automated undo path**: a worker that
corrupts or deletes files mid-run cannot be rolled back by the SCM layer.

**Mitigations:**

- **Run automated loops against a copy of the tree.** Point `--repo` at a
  disposable checkout (rsync/cp) rather than a tree you can't afford to lose;
  discard and re-copy on failure instead of trying to undo in place.
- **Initialize a throwaway git repo purely as an undo layer.** `git init` in
  the tree and commit before each run gives you `git reset --hard` as a manual
  escape hatch, while `.tasks/scm.json` still declares `backend: "none"` — the
  none-mode manifest walk already excludes `.git/`, so the shadow repo doesn't
  pollute the digest baseline or change detected-backend behavior.
- **Restore from backup.** Standard filesystem/VCS-external backups (snapshot,
  tarball, cloud sync) remain the fallback of last resort when no undo layer
  was set up in advance.

**What an orchestrator reports on a mid-flight failure.** Recovery is manual
and the run says so explicitly — the orchestrator never claims silent or
automatic recovery in none-mode. A failed run surfaces the `UNSUPPORTED_VERB`
exit code (or the underlying failure) and leaves the tree as-is for the
operator to inspect and recover by hand.

**Tuning the `ignore` knob to reduce recovery scenarios.** Gitignore-style
globs in `.tasks/scm.json`'s `ignore` array trim the baseline manifest beyond
the built-in exclusions (default `node_modules/`, `dist/`, `.git/`, `*.log`).
Excluding generated/build directories prevents baseline-churn false
positives — spurious "changed files" from regenerated artifacts that were
never touched by the task — which in turn reduces the number of situations
that look like a failure requiring manual recovery in the first place.

## Verification & isolation notes

- **Spelling policy (single source of truth):** the evidence field's forward
  name is `change_ids` (underscore); `commit_shas` is the retained back-compat
  alias. The CLI *verb* is spelled differently again — `change-id` (hyphen,
  singular) — because it names an action, not a field; its own JSON output key
  is `ids` (see the verb table above). Use `change_ids` everywhere this doc
  refers to the evidence field.
- **Evidence envelope generalizes.** `commit_shas` is conceptually
  **`change_ids`**: git SHAs (bare, unchanged wire shape), perforce CLs as
  `p4:<cl>`, or empty for none. `file_changes` comes from `scm changed-files`;
  `base_sha` from `scm baseline`. The wire field name is kept for backward compat.
- **`change_ids`/`base_id` are the forward names.** `commit_shas` (and
  `base_sha`) are retained as back-compat **aliases** of `change_ids`
  (`base_id`) respectively — new consumers should treat `commit_shas` as an
  alias, not the canonical name.
- **Anti-fabrication hook is backend-aware**, dispatching on value shape: bare
  hex → git SHA existence check, `p4:<cl>` → changelist existence check, empty
  array → none-mode pass.
- **Mixed-backend cross-repo runs** resolve per-repo (there is no run-global
  backend); isolation capability for a multi-repo task is the **MIN** across
  touched repos, so mixed-backend tasks run serialized. `record`/`publish` are
  not transactional across repos — the orchestrator reports per-repo outcomes and
  never claims run-level atomicity.
- **Identity** resolves from `git config user.email` → (`p4 info` User for
  perforce) → `$USER` → `claude-<model>-<purpose>`; a read-only source
  independent of SCM, retained in all modes.

## Backward compatibility

Repos with no `.tasks/scm.json` auto-detect to git and behave exactly as before.
The git adapter feeds the same `commit_shas` / `file_changes` wire fields with
the same bare-SHA values, so existing verifiers, the anti-fabrication hook, and
stored evidence rows are unaffected. The whole feature is opt-in.
