# Plan: Pluggable Source Control (SCM)

- **Date:** 2026-07-16
- **Spec (authoritative contract):** [../specs/2026-07-16-pluggable-scm-design.md](../specs/2026-07-16-pluggable-scm-design.md) — section refs below (§n) point there.
- **Status:** Ready for decomposition/execution.

## Goal

Implement the pluggable-SCM contract: `git`/`perforce`/`none` backends behind a single
`tasks scm <verb>` adapter CLI, repo-local `.tasks/scm.json` + auto-detect config, and
skill/verifier migration off raw git — with the existing git loop byte-green at every phase
boundary.

## Success criteria

- All §4 verbs implemented per backend with the §4.1 wire contract (JSON envelope, exit codes).
- Existing git loop behavior is byte-identical after P2 (same commits, same evidence values).
- none-mode loop runs end-to-end: baseline → changed-files → empty `change-ids` graded by verifier.
- Perforce collapse (§4.2), renumber capture, and submit-conflict policy (§4.3) proven by tests.
- `npm run quality:fast` green at the end of every phase (zero-tolerance).

## Ordering hazard (read first)

**P1 must land and be proven before any P2 skill edit.** The skills are the live production
surface of the git loop; the adapter (P1) is invisible until skills call it. Landing P1 fully
tested first means every P2 diff is a pure prose-swap against a proven binary — if a P2 task
regresses, revert the skill file, not the adapter. Never interleave P1 and P2 tasks in one wave.
P3 (perforce) and P4 (docs/charter) depend only on P1 and can proceed in parallel with each
other after P2.

## Surface-coverage matrix

| Capability | stdio MCP | remote MCP | REST | CLI | skills | client-package mirror | docs/tool-count | migration/backfill |
|---|---|---|---|---|---|---|---|---|
| SCM config (`.tasks/scm.json` + resolve + detect, §3) | N/A (file-based, no MCP surface) | N/A (same) | N/A (same) | T7 | T9 | N/A (no client copy) | T7 + T21 | N/A (new file, no schema) |
| Adapter verbs git/none (§4) | N/A (CLI-only chokepoint by design, §2.2) | N/A (same) | N/A (same) | T7 | T10, T11, T12 | T14 (verify no skills copy drifts) | T7 | N/A |
| Perforce backend (§4.2–4.3, §5.2) | N/A | N/A | N/A | T16 | N/A (verbs are backend-neutral; no skill edit) | N/A | T21 | N/A |
| Evidence generalization (`p4:<cl>` in `commit_shas`, §5.1) | T13 (hook + evidence schema check) | T13 | N/A | N/A | T9 | N/A | T21 | N/A (string field, no column change) |
| Charter `scm` default (§6.3) | T20 | T20 (parity in SAME task — documented stdio/remote parity trap) | T20 (get_project route field) | N/A | N/A (skills read via get_project) | N/A | T20 | T20 (migration 017) |

## Phase 1 — Abstraction + git/none parity (topology: DAG)

No skill changes. Git loop untouched. Phase gate: `npm run quality:fast` green; `git grep -l "tasks scm" skills/` returns nothing.

### T1 — `exec.ts` + safety tests
- **Goal:** the repo's only subprocess wrapper, per the §6.1 safety contract.
- **Files:** create `src/scm/exec.ts`, `src/scm/__tests__/exec.test.ts`.
- **AC (verifier-checkable):** `execFile`-style with `shell: false`; binary allowlist `git|p4|gh` rejecting path separators in argv[0]; 60s default / per-call timeout with SIGTERM→SIGKILL(5s) → exit 124; 10 MB output cap; `P4PASSWD` scrubbed from error payloads; stdin ignored. Tests cover: timeout escalation, output cap, hostile filenames (`$(x)`, leading `-`, spaces/unicode), env scrubbing, allowlist rejection.
- **Verify:** `npm run build && npx vitest run src/scm/__tests__/exec.test.ts && npm run lint`
- **Deps:** none.

### T2 — Config schema, resolver, detect
- **Goal:** §3 end-to-end: Zod `.strict()` schema (version 1, `ignore` globs), precedence file > charter > auto-detect, cwd walk-up + `--repo`, dual-marker refusal, charter-vs-marker conflict warning.
- **Files:** create `src/scm/types.ts` (`Backend`, `SCMConfig`, `Behaviors`), `src/scm/resolve-config.ts`, `src/scm/detect.ts`, `src/scm/__tests__/resolve-config.test.ts`, `__tests__/detect.test.ts`.
- **AC:** invalid config → exit-2 class error, never silent auto-detect fallthrough; `.git`+`.p4config` at same root refuses; charter hint loses to on-disk marker with warning; per-backend behavior defaults match the §3.3 table.
- **Verify:** `npm run build && npx vitest run src/scm/__tests__/ && npm run lint`
- **Deps:** none.

### T3 — `exclusions.ts` central invariant
- **Goal:** §4.4 exclusion list (`.planning/` artifacts, `.gitignore`, `data/*.db`, `.env`, `/bin`, `.tasks/.scm/`) checked on normalized repo-relative paths.
- **Files:** create `src/scm/exclusions.ts`, `src/scm/__tests__/exclusions.test.ts`.
- **AC:** `./foo`, `a/../foo`, and absolute-path escapes all normalize before matching; a stage set containing one excluded path fails the whole call listing offenders; path outside repo root rejected.
- **Verify:** `npx vitest run src/scm/__tests__/exclusions.test.ts && npm run lint`
- **Deps:** T2 (shared types).

### T4 — `SCMAdapter` interface + wire envelope
- **Goal:** §4.1 as code: one interface method per verb; envelope builder (`ok/verb/backend/context/data/warnings`, error codes enum); exit-code mapper (0/1/2/3/4/124); `--context` plumbed through.
- **Files:** extend `src/scm/types.ts`; create `src/scm/wire.ts`, `src/scm/__tests__/wire.test.ts`.
- **AC:** every §4.1 stable error code present; per-verb `data` shapes typed exactly as §4.1's normative list; single-line JSON stdout, human detail stderr.
- **Verify:** `npx vitest run src/scm/__tests__/wire.test.ts && npm run lint`
- **Deps:** T2.

### T5 — git adapter (behavior parity)
- **Goal:** §4 table git column, byte-for-byte parity with today's skill prose, plus §4.1 git preflights (detached-HEAD warning, `NO_REMOTE` downgrade, shallow-base failure, submodule-as-path, `--` option termination, never `add -A`/`.`).
- **Files:** create `src/scm/git-adapter.ts`, `src/scm/__tests__/git-adapter.test.ts` (mocked exec asserting exact argv).
- **AC:** argv assertions for every verb; exclusion list consulted on `stage`/`record`; `isolate` returns `{strategy:"platform-worktree"}` and creates nothing; `teardown-isolation` only touches worktrees recorded under `.tasks/.scm/<context>/`.
- **Verify:** `npx vitest run src/scm/__tests__/git-adapter.test.ts && npm run lint`
- **Deps:** T1, T3, T4.

### T6 — none adapter + baseline manifest + perf benchmark
- **Goal:** §5.5 normative manifest (per-context path, size+mtime fast path, sha256, symlink-as-target, ignore globs) and no-op verbs; `reset-hard` → exit 4.
- **Files:** create `src/scm/none-adapter.ts`, `src/scm/__tests__/none-adapter.test.ts`, benchmark in `src/scm/__tests__/none-manifest.bench.ts` (generated 50k-file tree, `status` single-digit seconds — the confirmed budget).
- **AC:** two `--context`s never stomp each other's baselines; mtime-rewrite of identical bytes is not a change; symlinks not followed; manifest id is `none:<sha256>` and re-derivable; benchmark pinned in suite (`npm run test:bench` target).
- **Verify:** `npx vitest run src/scm/__tests__/none-adapter.test.ts && npm run test:bench -- none-manifest && npm run lint`
- **Deps:** T1, T3, T4.

### T7 — CLI `tasks scm` + wire-contract tests + drift-guard extension
- **Goal:** wire verbs into the CLI (§6.2) and extend the doc-drift guard in the SAME task (known blind spot: new files dodge `interfaces-counts.test.ts` unless its hard-coded lists grow).
- **Files:** create `src/cli/commands/scm.ts`; register in `src/cli/bin/tasks.ts`; modify `src/**/interfaces-counts.test.ts` (locate exact path first) adding all new `src/scm/*` + `src/cli/commands/scm.ts`; create `src/cli/__tests__/scm-command.test.ts`.
- **AC:** every verb reachable via `npm run cli -- scm <verb>`; exit codes match the §4.1 table (empty `changed-files` = 0; nothing-staged `record` = 0 with `recorded:false`; none `reset-hard` = 4; invalid config = 2); JSON validates against T4 schemas; drift-guard test enumerates the new files.
- **Verify:** `npm run quality:fast`
- **Deps:** T5, T6.

> **§L hook located (spec §7's P1 "locate" deliverable is already satisfied):** the
> anti-fabrication hook is the in-repo reference hook `docs/hooks/validate-sha.mjs` (a Claude
> Code PreToolUse guard that git-probes SHAs and denies fabricated ones), with its reference
> test at `src/__tests__/validate-sha-hook.test.ts`. Distributed via `docs/hooks/` — no
> `~/.claude` sync mechanism involved. The former "T8: locate the hook" task is therefore
> dropped; the backend-aware adaptation is T13 in P2. Task ids T9+ are kept stable.

## Phase 2 — Skill migration (topology: DAG, shallow)

Gate to start: ALL of P1 merged + green. Every task here touching `skills/` MUST run
`npm run build:skills` and never edit `dist/` directly. Phase gate: git loop dry-run produces
byte-identical commit/evidence behavior; none-mode loop functional end-to-end.

### T9 — `loop-shared.md`: envelope + shared prose + version-skew preflight
- **Goal:** generalize §B per spec §5.1 (`commit_shas` carries bare SHAs / `p4:<cl>` / empty; `base_sha` from `scm baseline`; `file_changes` from `scm changed-files`); update §A brief template + §N teardown to verbs; add the §6.4 run-start `scm detect` preflight (abort loudly on unknown command, never fall back to raw git).
- **Files:** modify `skills/tasks/loop-shared.md`; check `scripts/validate-evidence.ts` accepts `p4:`-prefixed strings (string field — assert, don't assume); rebuild via `npm run build:skills`.
- **AC:** no remaining raw `git` write-verb instructions in the touched sections (read-only identity `git config user.email` stays per §5.4); §B text states the namespacing rule; preflight paragraph present; `dist/skills/` regenerated.
- **Verify:** `npm run build && npm test && npm run lint`
- **Deps:** T7 (P1 complete).

### T10 — `loop.md`: Step 6 + pre-flight + evidence capture → verbs
- **Goal:** replace commit/push/status/rev-parse prose with `tasks scm stage/record/publish/baseline/change-id/changed-files`, preserving the record→publish sequence (§4.2 keeps it backend-neutral).
- **Files:** modify `skills/tasks/loop.md`; `npm run build:skills`.
- **AC:** every former git invocation in Step 6 and evidence capture maps to a named verb; evidence values still copied from returned tool output (anti-fabrication §L discipline unchanged); "Do NOT commit" worker-brief trailer unchanged.
- **Verify:** `npm run build && npm test && npm run lint`
- **Deps:** T9.

### T11 — `loop-dag.md`: capability-gated isolation + downgrade path
- **Goal:** worktree mandate becomes: resolve `scm detect` capabilities up front; git → platform `isolation:"worktree"` (unchanged, incl. stale-base defenses); p4 → temp client; else the §5.2 downgrade (forced concurrency 1, downgrade recorded in LOOP-RUN.md as first status line, DAG order preserved). Mixed-backend per-task MIN rule (§4.5).
- **Files:** modify `skills/tasks/loop-dag.md`; `npm run build:skills`.
- **AC:** no unconditional `isolation:"worktree"` instruction survives; downgrade path spelled out with all four §5.2 steps; stale-base defenses 1–3 retained verbatim for the git path.
- **Verify:** `npm run build && npm test && npm run lint`
- **Deps:** T9.

### T12 — Verifier + auditor allow-lists → read-only scm
- **Goal:** `tasks-verifier.md` / `integration-auditor.md` read-only-git allow-lists become read-only-scm (git read verbs / p4 read verbs / none manifest reads), and the verifier's base-integrity first check works from `base_sha` in all three modes (git SHA / p4 CL / `none:<digest>` re-derivation).
- **Files:** modify `skills/agents/tasks-verifier.md`, `skills/agents/integration-auditor.md`; `npm run build:skills`.
- **AC:** allow-lists enumerate permitted read commands per backend; none-mode grading path (empty `change-ids` + filesystem diff) described; no write verb appears in either allow-list.
- **Verify:** `npm run build && npm test && npm run lint`
- **Deps:** T9.

### T13 — Make `docs/hooks/validate-sha.mjs` backend-aware
- **Goal:** per §5.3: shape-dispatch validation in the located hook (bare hex → git SHA existence probe, unchanged; `p4:<cl>` → changelist exists via `p4 describe -s <cl>` / `p4 changes`; empty `change-ids` → skip validation entirely).
- **Files:** modify `docs/hooks/validate-sha.mjs`; extend `src/__tests__/validate-sha-hook.test.ts` with the p4 and none/empty cases.
- **AC:** existing git test cases pass unmodified (git behavior byte-unchanged); `p4:123` no longer hard-rejected; empty array passes without any subprocess probe; a fabricated `p4:999999` is denied when a p4 session is available and degrades to warn-only when p4 is unreachable (offline verifier must not brick, §4.1 exit-3 semantics); the probed value rides as a discrete argv entry — no shell-string interpolation (same discipline as §6.1).
- **Verify:** `npx vitest run src/__tests__/validate-sha-hook.test.ts && npm test && npm run lint`
- **Deps:** T9 (namespacing rule must be final before the hook encodes it).

### T14 — P2 integration gate: byte-identical git + none-mode E2E
- **Goal:** prove the phase claim. (a) Git: run a scripted single-task loop dry-run against a fixture repo pre/post-P2 and diff the produced commit shape + §B envelope values. (b) none: fixture dir without `.git`, full loop cycle, verifier grades empty `change-ids`. (c) Confirm no second copy of the touched skills exists in any client package (documented dual-source drift trap).
- **Files:** create `scripts/smoke/scm-parity-smoke.sh` (or extend existing smoke); no skill edits.
- **AC:** parity diff empty for git; none-mode run reaches verified-done; `grep -rl "git add\|git commit" skills/tasks/loop*.md` shows only intentional remnants (identity read, git-path-specific §A defenses); smoke wired into CI or `npm run smoke`.
- **Verify:** `npm run quality:fast && ./scripts/smoke/scm-parity-smoke.sh`
- **Deps:** T10, T11, T12, T13.

## Phase 3 — Perforce adapter (topology: DAG; can run parallel with P4)

Gate to start: P1 merged (P2 not required — the adapter is skill-invisible until selected).

### T15 — mock-p4 test harness
- **Goal:** a scriptable fake `p4` (argv-in → canned stdout/exit) so all P3 unit tests run hermetically; real `p4d` integration stays behind an env flag.
- **Files:** create `src/scm/__tests__/helpers/mock-p4.ts`.
- **AC:** harness can simulate: login expired, server unreachable, submit renumber output, submit conflict, opened/describe listings.
- **Verify:** `npx vitest run src/scm/__tests__/helpers/ && npm run lint`
- **Deps:** T7.

### T16 — perforce adapter core verbs
- **Goal:** §4 table p4 column: reconcile/opened/describe/status, numbered pending CL per `--context` (never default CL), session preflight → `AUTH_EXPIRED`/`BACKEND_UNAVAILABLE` exit 3, no interactive prompts.
- **Files:** create `src/scm/perforce-adapter.ts`, `src/scm/__tests__/perforce-adapter.test.ts`; extend `interfaces-counts.test.ts` lists in this task.
- **AC:** argv assertions per verb; exclusions consulted; offline/expired map to exit 3 without hanging (timeout ceiling from T1).
- **Verify:** `npm run quality:fast`
- **Deps:** T15.

### T17 — semantic collapse + renumber + submit-conflict policy
- **Goal:** §4.2 three-way toggle mapping (submit / shelve / reconcile-only) and §4.3: renumber capture (final CL from submit output into `publish.data.changeId`; evidence never quotes a pending CL in publish-on runs), sync + `resolve -as` retry-once, `SUBMIT_CONFLICT` with CL number in payload, never `-at`/`-ay`.
- **Files:** modify `src/scm/perforce-adapter.ts`; extend tests.
- **AC:** all three toggle combinations tested; pending≠submitted CL test proves post-renumber capture; conflicted CL left pending with files open.
- **Verify:** `npx vitest run src/scm/__tests__/perforce-adapter.test.ts && npm run lint`
- **Deps:** T16.

### T18 — temp-client isolation + teardown
- **Goal:** §5.2 p4 path: provision temp client from configured template into a scratch dir; absent template → `isolate` reports `serialized`; `teardown-isolation` reverts opened files then deletes the client. Template format is designed here (the P3 design item deferred from the spec).
- **Files:** modify `src/scm/perforce-adapter.ts`, `src/scm/types.ts` (template config field, additive); tests.
- **AC:** no template → `{strategy:"serialized"}` (never an error); teardown never deletes a client it did not record under `.tasks/.scm/<context>/`.
- **Verify:** `npx vitest run src/scm/__tests__/perforce-adapter.test.ts && npm run lint`
- **Deps:** T16.

### T19 — p4 identity + real-p4d gated integration
- **Goal:** §5.4 `p4 info` User ahead of `$USER`; end-to-end integration test against a real `p4d` gated by env flag (mirror the `WFG_TESTS_REAL` pattern — default suite stays hermetic on the mock).
- **Files:** modify `src/scm/perforce-adapter.ts`; create `src/scm/__tests__/perforce-integration.test.ts` (skipped unless flag set).
- **AC:** default `npm test` runs zero real-p4d tests; flag-on run exercises baseline→stage→record→publish→change-id round-trip.
- **Verify:** `npm run quality:fast` (and flag-on run recorded once manually).
- **Deps:** T17, T18.

## Phase 4 — Charter, docs, guards (topology: FLAT; can run parallel with P3)

Gate to start: P1 merged. T20 is independent of P2/P3.

### T20 — Charter `scm` default: migration 017 + MCP/REST parity
- **Goal:** §6.3 precedence-2 fallback: `scm` field in the project charter, surfaced on `get_project` — **stdio MCP, remote MCP, and REST project route in the SAME task** (the documented remote-parity planning gap must not recur).
- **Files:** create `src/db/migrations/017-scm-charter.ts` (pattern: `014-value-charter.ts`); modify the project MCP tool + remote proxy + REST project route + repository serialize/parse; tests for all three surfaces.
- **AC:** field round-trips via stdio MCP, remote MCP, and REST; absent field = no fallback (resolver already tolerates null per T2); migration is additive and reversible; `interfaces-counts.test.ts` / README tool-count untouched or extended as needed.
- **Verify:** `npm run quality:fast && npm run migrate` (against a scratch DB, never the prod path).
- **Deps:** T7 (resolver consumes the field), independent of P2/P3.

### T21 — `docs/SCM.md` contract + AGENTS.md nav + CHANGELOG
- **Goal:** user-facing contract doc (§6.5): config schema, verb table + wire contract, per-backend semantics incl. the §4.2 collapse and §5.5 none limits, downgrade behavior, mixed-backend rules.
- **Files:** create `docs/SCM.md` (include a "§L hook" section documenting `docs/hooks/validate-sha.mjs` and its backend dispatch); modify `AGENTS.md`, `CHANGELOG.md`.
- **AC:** every §4 verb documented with its exit codes; `npm run agent-context:check` green; CHANGELOG entry present.
- **Verify:** `npm run agent-context:check && npm run lint`
- **Deps:** T7 (content exists); T17/T18 refine p4 sections if P3 landed first — otherwise mark p4 sections "as specified, lands P3".

### T22 — Final sweep: examples + full quality gate
- **Goal:** example `.tasks/scm.json` files (git explicit, perforce, none), README touch-ups within the line budget, and a full `npm run quality` pass over the integrated tree.
- **Files:** create `docs/examples/scm/*.json`; modify `README.md` if needed.
- **AC:** `npm run quality` green (build, tests, lint, format, knip, depcruise, audit); no `dist/` hand edits anywhere in the branch.
- **Verify:** `npm run quality`
- **Deps:** T20, T21 (and whatever of P3 is merging in the same release).

## Dependency summary (for /tasks:decompose or /tasks:loop-dag)

```
P1 (DAG):  T1 ─┐            T2 ─→ T3, T4
               ├→ T5 ─┐
   T3,T4 ─────┤       ├→ T7      (T8 dropped — hook already located)
               └→ T6 ─┘
P2 (DAG):  T7 → T9 → {T10, T11, T12, T13}; {T10..T13} → T14
P3 (DAG):  T7 → T15 → T16 → {T17, T18} → T19
P4 (FLAT): T7 → {T20, T21} → T22
Cross-phase: P2 requires ALL of P1. P3 ∥ P4 after P1. P3 ∥ P2 (adapter is skill-invisible).
```

Critical path: T1/T2 → T5 → T7 → T9 → T10/T11 → T14.

## Out of scope

- Content-snapshot `reset-hard` for none mode (§10 — accepted manual recovery in v1).
- Changing the platform harness worktree base-ref behavior (upstream limitation; defenses stay).
- Swarm review automation beyond `open-review`'s shelve + clean-skip.
- Any redeploy of `/opt` production; this plan ends at merged + released code.
