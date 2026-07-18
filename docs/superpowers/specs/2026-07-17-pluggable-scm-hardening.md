# Pluggable SCM — Pre-Release Hardening

- **Date:** 2026-07-17
- **Status:** Approved (evaluation review of `feat/pluggable-scm`, Stuart + Claude)
- **Parent spec:** `docs/superpowers/specs/2026-07-16-pluggable-scm-design.md` (the §-numbers below refer to it)
- **Branch:** all work lands on `feat/pluggable-scm` before the public-release PR.

## 1. Context

A pre-release evaluation of the drained project-53 stack found the adapter architecture sound
and the git path release-ready, but identified (a) five places where docs promise behavior the
code does not implement, (b) a Perforce backend that has only ever run against a mocked exec
layer and carries several real-server incompatibilities, (c) residual raw-git in
`loop-shared.md` reachable from backend-agnostic paths, and (d) missing tests/docs required
for public release. This spec enumerates the full fix set. Every item below is normative.

## 2. Doc-vs-code contradictions (docs and code MUST agree)

### 2.1 Ambiguous dual-marker root must refuse

`detectBackend` (`src/scm/detect.ts:84-93`) silently returns `git` when both `.git` and a
perforce marker (`.p4config` / `.p4`) exist at the same resolved root. Parent spec §3.2 and
`docs/SCM.md:92-94` require: both markers at the same root → auto-detect refuses,
`CONFIG_INVALID`, exit 2, message demanding an explicit `.tasks/scm.json`. Implement the
refusal; add config-detect tests for: both-markers-refuse, marker-above-walk-root-ignored.

### 2.2 Charter precedence tier must actually resolve

Parent spec §3.2 tier 2: the project charter `scm` field is a default-only fallback for repos
with **no** `.tasks/scm.json` and **no** detectable marker. Storage (migration 017), schema,
and `get_project` surfacing exist, but `resolveBackend` (`src/scm/detect.ts`) never consults
it — `source: "charter"` (declared in `src/scm/types.ts:72`) is unreachable, and
`ScmBackendSource` in detect.ts omits `'charter'`. Wire it: the CLI accepts an optional
`--charter-scm <json>` flag (the orchestrating skill passes the charter's `scm` object it
already fetched via `get_project`; the adapter itself stays DB-free per §2.3 of the parent
spec). Resolution order becomes file → marker auto-detect → charter hint → `none`. If the
charter names a backend contradicted by an on-disk marker, the marker wins and a `warnings[]`
entry names the conflict (§2.4 below makes warnings real). Tests: charter-only repo resolves
from charter with `source:"charter"`; charter-vs-marker conflict warns, marker wins.

### 2.3 `branchPerRun` must fail loudly, not silently no-op

`branchPerRun: true` is schema-accepted (`src/scm/config.ts:45`) but implemented nowhere.
v1 decision: **reject, do not implement.** Loading a config with `branchPerRun: true` is a
`CONFIG_INVALID` (exit 2) with message "branchPerRun is not yet implemented — remove it from
.tasks/scm.json" — a Zod `.refine` on the config schema, mirrored in the charter schema
(`src/schemas/scm-charter.schema.ts`). `docs/SCM.md` updates the behaviors table to mark it
"reserved — rejected in v1". Tests: config with `branchPerRun: true` exits 2; `false` loads.

### 2.4 The `warnings[]` channel must be live

`src/cli/commands/scm.ts:182` hardcodes `warnings: []`. Backends must be able to return
warnings through the envelope. Plumb a `warnings: string[]` through `ScmVerbResult` /
backend return shapes (types already declare the optional field, `src/scm/types.ts:220`) and
emit the two documented cases:
- git `record` on a detached HEAD → warning "detached HEAD — publish will fail from this
  state" (call the existing `isDetachedHead`, `src/scm/git.ts:217`, from `record`).
- charter-vs-marker conflict per §2.2.
Tests: both warnings appear in the envelope; success with no warnings still prints `[]`.

### 2.5 Backend-gate the raw-git residue in `loop-shared.md`

Two executable raw-git paths remain in `skills/tasks/loop-shared.md`, reachable from
backend-agnostic orchestration:
- STEP 0 worktree-base guard (`git reset --hard <integration-branch>` brief template,
  lines ~39-45).
- §Q worktree-patch integration (`git apply --3way --index`, `git reset --soft`,
  `git checkout <tree-ish> --`, lines ~818-857), reachable from `loop-dag.md` §3d.

Both are legitimately git-only (they exist only inside the platform-worktree isolation path),
but nothing gates them. Fix: wrap each in an explicit prose gate — "GIT/PLATFORM-WORKTREE
ISOLATION ONLY: skip this entire step unless `tasks scm detect` reported
`capabilities.isolation == "platform-worktree"`" — so a perforce/none run can never reach
them. Also migrate the two incidental raw-git reads (`loop-shared.md:709` reachability diff,
`:376/:382` verifier evidence-excerpt placeholders) to `tasks scm changed-files` phrasing
where the verb suffices, or gate them identically where it does not. Edit `skills/` source,
then `npm run build:skills`; guard tests asserting the gate text exists (grep-style, like the
task-1538 guard tests).

## 3. Perforce correctness batch (all in `src/scm/perforce.ts` unless noted)

### 3.1 Non-interactive changelist forms must actually work

`p4 --field Description=… change -i` (line ~254) cannot work: `-i` reads the changespec form
from stdin, which `exec.ts` pins to `ignore`; `--field` only rewrites the output of form
commands (`change -o`). Fix: add a **scoped stdin capability** to `exec.ts` — a new
`stdinData?: string` option that, when set, pipes the given buffer to the child and closes
stdin (everything else about the §6.1 contract unchanged; interactive prompting remains
impossible because stdin is finite). Then implement the canonical pattern: run
`p4 --field Description=… change -o` capture stdout, feed it to `p4 change -i` via
`stdinData`. Same for `setChangelistDescription` (`--field Change=… --field Description=…
change -o` → `change -i`). exec tests: stdinData is delivered verbatim (hostile bytes
included), stdin still closes, timeout semantics unchanged.

### 3.2 Drop `--` for p4 invocations

p4 does not support `--` as an end-of-options terminator; `p4 reconcile -c <cl> -- <files>`
(line ~350) treats `--` as a filespec. Remove `--` from every p4 argv. Leading-dash filename
protection for p4: reject a staged path beginning with `-` at the adapter boundary
(`CONFIG_INVALID`, exit 2, message naming the path) — p4 offers no safe positional escape.
Update the parent spec's blanket "`--` everywhere" phrasing note in `docs/SCM.md`.

### 3.3 Repo-relative paths on the p4 wire

`p4 opened` emits depot syntax (`//depot/...`), violating the §4.1 repo-root-relative
contract, silently defeating the §4.4 exclusion filter (repo-relative patterns never match
depot paths), and making `file_changes` evidence shape-inconsistent across backends. Fix:
use `p4 -ztag opened [-c <cl>]` and map each record's `clientFile` to a repo-root-relative
forward-slash path (strip the client root; `p4 -ztag where` fallback for unmapped cases).
`status` and `changedFiles` both emit repo-relative paths; exclusion filtering then works
unchanged. Tests: ztag parsing, depot→relative mapping, exclusion filter now effective.

### 3.4 Revert semantics: discard-all means `p4 revert //...`

`p4 revert -a` reverts only files opened-but-unchanged — so `resetHard` (line ~488) and
`teardownIsolation` (line ~479) leave real edits in place, and `p4 client -d` then fails on
a client with opened files. Fix: `resetHard` runs `p4 revert //...` then `p4 sync @<cl>`
(empty ref → plain `p4 sync`); `teardownIsolation` runs `p4 revert //...` scoped to the temp
client (`-c` changelist scope where applicable) before `p4 client -d`. Also fix the parent
spec's §4 table text in `docs/SCM.md` (it repeats the `-a` mistake). Tests pin the new argv.

### 3.5 `status` must include unopened local changes

Parent spec §4 says perforce `status` = `p4 opened` + `p4 status`; the code runs only
`opened`, missing unopened local edits (common in `allwrite` clients). Add a `p4 status`
(preview reconcile) pass and merge its add/edit/delete findings into `entries` (repo-relative
per §3.3), de-duplicated against the opened set. Tests: an unopened local edit reports dirty.

### 3.6 `isolate` must never claim isolation it did not provision

The p4-client path (lines ~463-473) names a client and returns without creating anything —
an orchestrator would parallelize on false isolation (the documented shared-tree stomping
hazard, with no worktree backstop). v1 decision: **always report `serialized`** for perforce
regardless of `P4CLIENT_TEMPLATE`; delete the unprovisioned p4-client branch and the
`P4CLIENT_TEMPLATE` env knob entirely (code, tests, and any doc mention). `detect` reports
`capabilities.isolation: "serialized"`. Real temp-client provisioning returns in a future
release with the real-p4d suite proving it. `docs/SCM.md` states this plainly ("perforce
loops run serialized in this release").

### 3.7 Identity: add `p4 info` source

Parent spec §5.4: for perforce repos, `p4 info` User name slots in ahead of `$USER` in the
skill identity-resolution chain. Update the identity prose in the skills (loop-shared §A
identity resolution) — read-only, best-effort, never fails the run.

### 3.8 Preflight once per process, not per verb

`p4 login -s` runs before every verb — a server round-trip per call. Cache the successful
preflight in-process (module-level, per repo root) so a single CLI invocation probes at most
once; a CLI process is short-lived so staleness is bounded by process lifetime. Tests: two
verbs in one process → one `login -s` in the mock exec log.

## 4. Real-`p4d` integration suite

New env-gated suite (`WFG_TESTS_REAL_P4=1`, mirroring `WFG_TESTS_REAL`) that provisions a
throwaway Helix server via the official `sourcegraph/helix-p4d` (or `perforce/helix-p4d`)
Docker image on an ephemeral port, creates a client, and exercises the full verb cycle
against it: baseline → stage (reconcile) → record (shelve path AND submit path) → publish
(renumber capture asserted: pending CL ≠ submitted CL) → changed-files → status →
reset-hard → submit-conflict path (second client submits underneath, assert
sync + `resolve -as` retry-once then `SUBMIT_CONFLICT`). The suite must skip cleanly
(not fail) when Docker or the image is unavailable and `WFG_TESTS_REAL_P4` is unset.
Document the knob in the test-suite README/docs. This suite is the graduation criterion for
removing perforce's "experimental" label (§6.1) — CI wiring is optional in this pass, local
runnability is mandatory.

## 5. none-mode completion

### 5.1 §5.5 performance benchmark test

The parent spec promised a generated-tree benchmark pinning the walk's performance envelope.
Add a test that generates a synthetic tree (target ≥ 10k files — sized so CI stays fast; the
50k budget scales linearly) under a temp dir, captures a baseline, mutates a handful of
files, and asserts (a) `changed-files` finds exactly the mutations, and (b) the steady-state
re-walk re-hashes only touched files (assert via hash-call counting or a wall-clock ceiling
generous enough to never flake, e.g. 30s). Placement: `src/scm/__tests__/none-perf.test.ts`.

### 5.2 Manual-recovery documentation

`docs/SCM.md` none-mode section gains a "Recovery in none-mode" subsection: what
"reset-hard unsupported" means operationally, recommended mitigations (run loops on a copy;
initialize a throwaway git repo purely as an undo layer while keeping `backend: "none"`
semantics; restore from backup), and what the orchestrator reports when a run fails
mid-flight. Also surface the `ignore` tuning knob here (baseline churn false-positives).

## 6. Docs & release surface

### 6.1 Three persona quickstarts + experimental label

Top of `docs/SCM.md`: a "Quickstart" section with three subsections — **git** ("zero config:
behavior is unchanged"), **perforce** (`p4 login` ticket setup, minimal `.tasks/scm.json`,
p4 client version floor 2021.1+ for `--field`, serialized-loop expectation per §3.6),
**none** (what `.tasks/.scm/` is, `ignore` tuning, the no-undo caveat) — each ending with
`tasks scm detect` and its expected JSON as the smoke test. Perforce sections carry an
explicit **"experimental — pending real-server validation (§4 suite)"** label; the
CHANGELOG entry for the release says the same.

### 6.2 `change_ids` alias direction

Keep `commit_shas`/`base_sha` wire names for back-compat, but document in `docs/SCM.md`
(evidence section) that `change_ids`/`base_id` are the forward names: the verifier envelope
docs in `loop-shared.md` §B note the alias, and new consumers are directed to treat
`commit_shas` as an alias of `change_ids`. Documentation-only in this pass — no wire change.

### 6.3 Drift-guard extension

Extend `tool-count-drift.test.ts` file lists to cover `src/scm/*.ts` and
`src/cli/commands/scm.ts` so new SCM files cannot dodge the doc-drift guard (the documented
PR-#55 blind spot). Assert `docs/SCM.md`'s verb table row count matches `SCM_VERBS` length.

### 6.4 git `record` error-code fidelity

`src/scm/git.ts:207` maps every non-"nothing to commit" failure to `DIRTY_TREE`. Classify:
hook failure / missing identity (`user.email`) → `BACKEND_UNAVAILABLE` with the git stderr
tail and a hint; keep `DIRTY_TREE` only where the tree state is actually the cause. Tests
pin both classifications.

## 7. Constraints

- Zero-tolerance: `npm run quality:fast` green after every task; full suite green at the end.
- Byte-parity: the git loop must remain byte-identical — the existing parity smoke
  (task-1540 suite) must pass unchanged after §2.4/§6.4 (warnings ride the envelope, never
  stdout data shapes consumed by the parity smoke).
- Skills edits go to `skills/` source then `npm run build:skills`; never edit `dist/`.
- Mock-exec tests assert exact argv (per parent spec §8); every argv change re-pins tests.
- No `.planning/` artifacts staged; the §4.4 exclusion invariant applies to this work too.
