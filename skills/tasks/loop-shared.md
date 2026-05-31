---
name: loop-shared
description: Shared reference contracts for /tasks:loop and /tasks:loop-dag — worker brief template, VerifierInputs envelope spec, and LOOP-RUN.md frontmatter table. Documentation-only; never invoked.
disable-model-invocation: true
---

# Loop Shared Contracts

This file holds the load-bearing reference blocks that BOTH `/tasks:loop` (sequential) and `/tasks:loop-dag` (wave-parallel) cite. Extracted from `loop.md` to eliminate duplication across the two executors. The full prose of each step still lives in `loop.md` / `loop-dag.md`; this file owns the verbatim templates / schemas they share.

The blocks below are NOT independently invocable — they are reference material the orchestrator consults while executing a step. Read them in-context from the step that links here.

---

## §A. Worker brief template

**Called from:** `loop.md` §Step 4 (Dispatch a subagent), `loop-dag.md` §Step 3b (Claim and dispatch in parallel) / §6a (Worker brief template summary).

Brief template — adapt to the task. Brief size should scale with codebase quality: if you know the repo is already well-typed and well-tested, prefer thinner briefs (keep the constraint list intact but drop worked-example idioms); if the repo is messy, beef up the "decisions in the brief" and "preferred idioms" sections.

```
You are implementing wood-fired-tasks task #<id> ("<title>") from project "<project_name>".
Working dir is `<repo_root>`. Do NOT commit — the orchestrator will commit after verifying your work.

## Working dir / Cross-repo context

<for single-repo tasks: just restate the working dir line above; this subsection can be omitted.>
<for cross-repo tasks (flagged in §2a, baselined in §2c) — REQUIRED:>

- Primary working dir: `<absolute path to the sibling repo this task targets>` — `cd` here before any edits or validation runs.
- Why this isn't CWD: this task's acceptance criteria reference files under `<that path>`, which is outside the orchestrator's CWD (`<orchestrator CWD>`).
- Per-repo baseline (from §2c):
  - Build: `<repo's build command>` — currently `<ok | fail>`.
  - Tests: `<repo's test command>` — currently `<N passing, M failing>`.
  - Known pre-existing flakes (do NOT attribute these to your changes): `<test names from §2c known_flakes>`.
- Per-repo state at loop start: `<branch>` branch, `<clean | N uncommitted files>` working tree. If you need to add new commits, target `main` unless instructed otherwise.

## Acceptance criteria (from the tasks database, verbatim)

<paste the task description's "Acceptance criteria:" block here>

## Relevant domain context (excerpts only, not the whole doc)

<paste the relevant section/line range from the domain spec doc(s) you read in Section 2a>

## Repository conventions (already discovered — don't re-evaluate)

- Stack: <language, runtime, key frameworks>
- Build: `<build command>`
- Tests: `<test command>` (current baseline: <N> tests / <M> files passing)
- Existing CI patterns: <one-line summary>
- Source tree shape: <one-line summary>
- Validation memo path: `.tasks-loop-memo.md`
- Known-flake exclusions: sourced from `<repo>/.flaky-tests.json` (schema v1; `fqn` + `reason` + `filed_at` + `tracking_issue` per entry). The listed tests have already been excluded from the baseline via `<runner's exclude-by-FQN flag>` and MUST remain excluded from the post-edit run using the same flag.

## Test filter cheat sheet (per-runner exclusion syntax)

Include this block in briefs whose target cwd contains a `.sln`, `.csproj`, or `global.json` (.NET) OR a `package.json` with vitest in deps (Node + vitest).

For .NET xunit-v3 Microsoft Testing Platform repos, the orchestrator MUST embed this VERBATIM so the subagent reaches for the right flag on the first attempt instead of round-tripping through MTP help text (the `dotnet test` `--filter "FullyQualifiedName!~..."` syntax is xunit-v1/v2 and will be rejected by MTP):

```
.NET xunit-v3 MTP filter syntax (NOT the dotnet-test CLI's --filter):
  --filter-method     <FQN>        # run one method
  --filter-not-method <FQN>        # exclude one method
  --filter-class      <FQTypeName> # run one class (wildcards * supported)
  --filter-namespace  <ns>         # run a namespace
  --filter-not-namespace <ns>      # exclude a namespace
  --filter-trait      name=value   # run by trait
  --filter-not-trait  name=value   # exclude by trait
  --filter-query      <q>          # full xunit query-filter language
  --filter-uid        <uid>        # by test UID
Combine multiple --filter-not-* flags as AND. Pass after a `--` separator when invoking via `dotnet test`.
```

For Node repos that use vitest (detected by `vitest` appearing in `package.json` `dependencies` / `devDependencies` / a `test` script that invokes `vitest`), embed this parallel block:

```
vitest filter syntax:
  -t '<grep>'            # run tests whose name matches the substring/regex (alias of --testNamePattern)
  --testNamePattern <re> # same as -t, long form; regex matched against the full test name path
  --exclude '<glob>'     # exclude FILES by glob (e.g. 'tests/e2e/**'); applied on top of `test.exclude` in vitest config
  <positional pattern>   # positional args are FILE-name filters, not test-name filters
Note: vitest has no `--skip` flag — skipping individual tests is a source-level concern (`it.skip`, `describe.skip`, `test.skipIf(...)`). To EXCLUDE a single test at the CLI, prefer a negated `-t` regex (e.g. `-t '^(?!FlakyName).*$'`) or move the file out of the run set with `--exclude`.
```

Other runners (pytest, jest, go test, cargo test) are not included here yet — add a parallel block per runner when the loop first encounters that stack. Absence from this cheat sheet means "not yet documented", NOT "the runner has no exclusion syntax".

## Baseline first (run BEFORE any code edits)

Before touching any source files, run the test runner exactly as the orchestrator did in §2c — using the same `.flaky-tests.json` exclusion filter — and record the pre-edit pass/fail set. This baseline is what the orchestrator's Step 5 will diff against to compute regressions introduced by your change. The `.flaky-tests.json` filter is applied BEFORE this report (the orchestrator already supplied the exclusion list above), so the failing-FQN list below reflects "real" failures only — not known flakes.

Report the following block VERBATIM at the top of your "Reporting back" summary, before any edits:

- **Command + flags:** `<test>` `<exclusion flags, if any — copy from "Known-flake exclusions" line above; empty if the repo has no .flaky-tests.json>`
- **Pass count:** `<N> / <total>`
- **Failing FQNs:** `none` OR a bulleted list of the failing test fully-qualified names. **Cap the list at 20 entries.** If the baseline has more than 20 failing tests, DO NOT truncate silently — surface it as a discovered concern, stop, and report back without editing. A baseline that red is itself the issue and the orchestrator must address it before you proceed.
- **Skipped / ignored count:** `<count>`

If the baseline contradicts what the orchestrator's brief told you to expect (e.g. brief says "expect 2493 passing, none failing" but you see 2491 passing with 2 failures), STOP and surface it in your reporting block — do NOT start editing on top of an unexpected baseline.

## Required deliverables

<concrete list — files to create, scripts to add, exact CLI entry points>

## Hard constraints

- Don't touch <out-of-scope areas>.
- Don't bulk-edit existing source unless absolutely required (and explain why if you do).
- Don't modify <config files unrelated to this task>.
- Build must stay green: `<build>` ends with zero errors.
- Test suite must stay green: `<test>` ends with the same pass count as baseline.
- <Any task-specific constraints — warning-free, format-untouched, no console additions, etc.>

## Validation steps (run all before reporting back)

1. `<build>`
2. `<test>` — must still report <N> passing. Apply the same `.flaky-tests.json` exclusion filter the orchestrator used for the §2c baseline (verbatim list above) so post-edit numbers match the baseline shape.
3. <task-specific check, e.g. `npm run lint` must be warning-free>

Iterate until all pass. If you conclude a check can only be satisfied by relaxing rules / scope, relax and document the choice in the summary.

## Reporting back

Return a tight summary (under 400 words). The first two subsections (**Baseline (pre-edit)** and **Post-edit**) are LOAD-BEARING — the orchestrator's Step 5 diffs them to detect regressions. Keep them as separate blocks with the exact field labels below so the diff is mechanical.

**Baseline (pre-edit)** — copied verbatim from the "Baseline first" block you ran before any edits:
- Command + flags: `<test>` `<exclusion flags or empty>`
- Pass count: `<N> / <total>`
- Failing FQNs: `none` OR bulleted list (≤20 entries; if more, you should already have stopped per "Baseline first").
- Skipped / ignored: `<count>`

**Post-edit** — same fields, captured after the final validation re-run:
- Command + flags: `<test>` `<exclusion flags or empty>` (MUST match Baseline exactly)
- Pass count: `<N> / <total>`
- Failing FQNs: `none` OR bulleted list.
- Skipped / ignored: `<count>`

Then the standard fields:
- Tooling / version chosen (if a choice was made).
- Files created or modified (full paths).
- Decisions and trade-offs (with one-line rationale each).
- Things you tried and disabled / deferred (so future tasks pick them up).
- Output of each validation step (pass/fail + headline numbers only).
- One-line suggested commit message.

Do NOT commit. Do NOT push. Do NOT modify the tasks database. The orchestrator owns those.
```

**Decision rules in the brief:**

- If a choice exists (tool A vs B, approach X vs Y), the orchestrator should pick one in the brief — based on the domain doc and stated preferences. Don't ask the subagent to choose; that drags decision-making into a context that lacks the project's full picture.
- Pass **excerpts** of domain docs, not the whole doc. The subagent doesn't need 500 lines of roadmap; it needs the 20 lines that anchor this task.
- When the brief asks the subagent to add a CI job, tell it explicitly: copy pinned action SHAs from a neighbouring job in the same workflow rather than fetching new ones. Otherwise the subagent may pick `@v4`-style floating refs that violate the project's pinning convention.
- **Audit-with-budget pattern.** When the acceptance criteria is "ensure X for every Y" (e.g. "every data-semantic migration has a targeted test", "every cast site is localised"), brief the subagent to *audit first, then act within a budget*. Typical budget: 1-2 fixes per iteration. If the audit surfaces 3+ gaps, the subagent adds **one** representative fix as a worked example, lists the remaining gaps in their summary, and the orchestrator records them in the close-out comment as recommended follow-on tasks. This prevents one task closure from ballooning into a sweep and keeps each commit coherent.
- Always end with "Do NOT commit". The orchestrator must stage and verify before any commit lands.

---

## §L. Anti-fabrication / evidence-integrity (CANON)

**Called from:** `loop.md` §Step 6 / §Step 7 + Important Rules, `loop-dag.md` §3d + Important Rules, and §B below. This is the single canonical statement of the rule; the callers state it tersely inline and point here.

**Anti-fabrication clause (load-bearing).** Every evidence value — git SHAs, row counts, dollar figures, exit codes, verdicts, message counts — MUST be copied verbatim from a tool result that has ALREADY RETURNED in a prior turn. Never compose, predict, or round-trip an evidence value in the same turn as the call that produces it. If you have not yet seen the producing tool's returned output, you do not yet have the value — stop and wait for it. Concretely: the `commit_shas` / `file_changes` passed to the verifier, and any number cited in a close-out comment, come from a `git rev-parse HEAD` / `git diff --name-only` / query that returned in an earlier turn — never from one batched into the same turn as the write that quotes it.

**One-state-mutation-per-turn.** During the verify/commit phases, perform at most ONE state-producing action per turn and let it return before citing its result. Never batch a `git commit` together with the `update_task` / `add_comment` that cites its SHA; never batch a query with the comment that cites its output. The sequence is strict: **run the producing call → read its returned output → THEN, in a later turn, write the evidence that quotes it.** This holds even when waves dispatch workers/verifiers in parallel — parallelism applies to *dispatch*, never to "issue a producing call and quote its not-yet-returned result in the same turn."

**Self-grading is forbidden.** `verification_evidence.verifier_session_id` MUST be the id of a SEPARATELY DISPATCHED `tasks-verifier` — never the orchestrator's own session, and never a literal like `"orchestrator"`, `"self"`, or `"main-loop"`. The orchestrator constructs the verifier *inputs*; it never authors the *evidence*. Writing your own verdict is fabrication, not verification.

**Honest scope.** A server-side guard (`WFT_STRICT_EVIDENCE`, default OFF) and a client-side SHA hook block the *structural* tells of fabrication — empty/self/placeholder verifier ids and non-existent git SHAs. Numeric truthfulness (a real-but-wrong row count, a misquoted exit code) is NOT machine-checkable and remains a discipline rule enforced by the rules above.

_Motivating incident (2026-05-31, project 28 via `/tasks:loop-dag`): an orchestrator batched dependent calls in one message and pre-wrote their results — non-existent git SHAs, metrics it never observed, a wrong exit code, an invented row count — then self-graded with `verifier_session_id="orchestrator-…"` instead of dispatching a verifier. See `docs/RELIABILITY.md`._

---

## §B. VerifierInputs envelope spec

**Called from:** `loop.md` §7a (Build the `VerifierInputs` envelope), `loop-dag.md` §3d (Verify each worker via `tasks-verifier`) / §6b (VerifierInputs envelope summary).

The orchestrator constructs a single JSON object matching the `VerifierInputs` interface in the contract:

```ts
const verifierInputs = {
  task_id: <id>,
  acceptance_criteria: <string>,         // see resolution rules below
  worker_subagent_session_id: <string>,  // opaque handle from the Step 4 Agent call
  commit_shas: <string[]>,               // from Step 6's `git rev-parse HEAD` / commit hash
  file_changes: <string[]>,              // from Step 6's `git diff --name-only <prev>..HEAD`
};
```

**Resolving `acceptance_criteria`** (in order):

1. Read the task's `acceptance_criteria` column via `wood-fired-tasks:get_task` (Wave 1.3 surfaces this as a first-class field).
2. If that column is NULL/empty, fall back to extracting the "ACCEPTANCE CRITERIA:" / "Acceptance criteria:" block from the task description (existing convention from Step 2).
3. If neither exists, **skip the verifier dispatch entirely** and proceed straight to Step 8 with `verification_evidence: { verdict: "NOT_VERIFIED", checks: [], verified_at: <iso8601> }` plus a comment noting "no acceptance criteria to grade against — verifier skipped". This is the documented escape hatch.

**Resolving `commit_shas` + `file_changes`**: after Step 6's `git commit`, capture `git rev-parse HEAD` and `git diff --name-only <pre-commit-sha>..HEAD`. If Step 6 produced multiple commits, list them in chronological order. If the worker reported "no changes needed" and Step 6 produced no commit at all, pass empty arrays — do NOT fabricate.

**Anti-fabrication (load-bearing — every value in this envelope is copied, never composed).** The `commit_shas` / `file_changes` arrays are populated verbatim from the `git rev-parse HEAD` / `git diff --name-only` calls that **returned in an earlier turn** — never from a `git` call batched into the same turn as building the envelope. The envelope is where a fabricated SHA does the most damage. Full rule + self-grading prohibition: **§L above (CANON)**.

**Scope-narrowed envelope for declared design-only / slice-of-epic tasks.** If §2a annotated this task with `scope: design-only` (or any other scope-narrowing label — `slice-of-epic`, etc.), the orchestrator MUST narrow `acceptance_criteria` in the envelope to the **in-scope AC bullets only** (the verbatim list recorded in §2a annotation field (b)). The out-of-scope / deferred bullets from §2a annotation field (c) MUST NOT appear in the envelope's `acceptance_criteria` field — the verifier never sees criteria it cannot honestly grade.

The orchestrator MUST also populate `additional_observations` in the envelope with a single entry of the form:

> `"SCOPE: <label>. This task is intentionally landing <label> per the orchestrator's planning decision. Runtime ACs are deferred to follow-on tasks (<list of task IDs OR 'to be created at close-out'>). Grade only the in-scope ACs listed above; do NOT add SKIP checks for the deferred runtime ACs."`

The `additional_observations` array tells the verifier that the narrowing is *deliberate* (an orchestrator planning decision), not a discovery gap the verifier should flag as UNCHECKABLE. Without this observation, the verifier may try to grade the missing AC bullets and emit spurious SKIP checks.

**Cross-reference: this is the ONLY legitimate path for an intentional narrowed-scope closure to reach PASS.** Without §2a's scope annotation, the orchestrator passes the full AC list and accepts whatever verdict the verifier returns — there is no inline shortcut, and §7c's "no upgrades" rule still binds. The §7d declared-scope carve-out is a status-level decision predicated on this envelope construction; it does NOT bypass it.

---

## §C. LOOP-RUN.md frontmatter required fields

**Called from:** `loop.md` §9c (Frontmatter construction), `loop-dag.md` §5c (Frontmatter construction) / §6d (LOOP-RUN.md frontmatter summary).

The YAML frontmatter is the 14 required fields from `docs/loop-run-schema.md` §3 (mirrored field-for-field in `docs/loop-run-schema.json` and `src/lib/loop-run/schema.ts`). Source for each:

| Field | Source |
|---|---|
| `run_id` | UUIDv4 minted once at run start; reused across every re-emission. |
| `project_id` | The `project_id` resolved in §1 (Argument Parsing → Resolve Project ID). |
| `started_at` | Captured at the top of §2 (Pre-Loop Discovery) as RFC 3339 UTC. |
| `ended_at` | `now()` at the moment of this emission, RFC 3339 UTC. |
| `wall_seconds` | `floor((ended_at - started_at).total_seconds())`. |
| `orchestrator_session_id` | `$CLAUDE_SESSION_ID` env var if set; literal string `unknown` otherwise. |
| `total_tokens` | Sum of input + cache_create + cache_read + output across orchestrator + every subagent. **Primary source:** the `<usage>` block returned by each `Agent` call in Steps 4 and 7 (deterministic, immediately available). **Cross-check source:** `agent_transactions_v` filtered by orchestrator + child `session_id`s — authoritative for retrospective audit but not required at emit time. |
| `total_usd` | Same primary/cross-check split as `total_tokens`; cache-discounted. |
| `subagents_dispatched` | Count of distinct subagent sessions spawned this run (worker dispatches in Step 4 + verifier dispatches in Step 7). |
| `tasks_attempted` | Tasks picked up so far (Step 1 increments this counter). |
| `tasks_passed` / `tasks_failed` / `tasks_partial` / `tasks_not_verified` | Decided by the Step 7 verdict for each task. Increments on the corresponding Step 7 branch. |
| `gate_decision` (optional) | Section 2f topology pre-flight gate; set once at run start. `allowed` for FLAT; `auto_ordered` for DAG resolved via Kahn's topological sort (Wave 11 default); `overridden` for DAG with `--i-know-what-im-doing` (skip auto-sort); `blocked` for DAG_CYCLIC. Omit the field for pre-#319 emissions (the schema marks it optional for backward compatibility). |

Use orchestrator-observed counts as the primary source; cite `agent_transactions_v` as the cross-check source for any post-run audit. The skill MUST NOT block emission on a live DB connection.

---

## §D. INTEGRATION-AUDIT.md schema

**Called from:** `loop.md` §10c (INTEGRATION-AUDIT.md schema), `loop-dag.md` §3f / §4 (per-wave and run-termination integration audits — both reuse this artifact shape).

Artifact path: `.planning/loops/<UTC-timestamp>-<project_id>-integration.md` (loop) or `.planning/loops/<UTC-timestamp>-<project_id>-wave<wave_index>-integration.md` (loop-dag per-wave). The skill prose IS the contract; there is no separate `docs/integration-audit-schema.md`.

**Frontmatter** (YAML, mirrors `IntegrationAuditFrontmatterSchema` in `src/lib/loop-run/integration-audit-schema.ts`):

```yaml
---
run_id: <UUIDv4 — REUSE the LOOP-RUN.md run_id; same run>
project_id: <integer>
generated_at: <RFC 3339 UTC>
overlap_count: <positive integer — file is only emitted when ≥ 1>
broken_count: <non-negative integer>
risky_count: <non-negative integer>
safe_count: <non-negative integer>
---
```

`broken_count + risky_count + safe_count` MUST equal `overlap_count` by construction — but the schema does NOT enforce the sum invariant (mirrors `LoopRunFrontmatterSchema`'s deliberate non-enforcement; the check is the replay tooling's job).

**Body** — one `## Overlap: <file_path>` block per overlap, ordered most-severe-first (BROKEN before RISKY before SAFE; within a severity, by file_path ascending):

```markdown
## Overlap: <file_path>

- **Tasks:** #<id_a>, #<id_b>
- **Verdict:** SAFE | RISKY | BROKEN
- **Rationale:** <auditor's rationale, ≤ 500 chars>

### Diff from task #<id_a>

\`\`\`diff
<git diff <pre>..HEAD -- <file_path> excerpt restricted to the hunks worker_a touched>
\`\`\`

### Diff from task #<id_b>

\`\`\`diff
<git diff <pre>..HEAD -- <file_path> excerpt restricted to the hunks worker_b touched>
\`\`\`

### Auditor evidence

- <evidence[0]>
- <evidence[1]>
- ...
```

---

## §E. Declared scope narrowing carve-out

**Called from:** `loop.md` §7d (Branch on verdict → PARTIAL branch), `loop-dag.md` §3d (Verify each worker via tasks-verifier — same verdict rollup).

When §2a annotated the task with `scope: design-only` (or any similar narrowing label) AND Step 7a passed `additional_observations` to the verifier per the "Scope-narrowed envelope" sub-block, the EXPECTED verdict is either **PASS** (all in-scope ACs cleanly observable) or **PARTIAL** (the verifier could not observe one or more in-scope ACs and emitted SKIP-UNCHECKABLE for them).

If the rollup is **PARTIAL** AND every SKIP check cites an *in-scope* AC (i.e. an AC bullet the orchestrator passed in the narrowed `acceptance_criteria` envelope — NOT a deferred runtime AC the orchestrator already removed in §7a), the orchestrator MAY transition `status` to `done` provided ALL of these hold:

1. **No FAIL checks.** Any FAIL → the task stays `in_progress` exactly as the default PARTIAL branch requires. The carve-out is a SKIP-only relaxation.
2. **Follow-on tracking is recorded.** The orchestrator has either (a) referenced existing follow-on task IDs in the close-out comment, OR (b) created a new task tracking the deferred runtime ACs (and that task ID is cited in the close-out comment).
3. **Audit trail is intact.** The close-out comment quotes the §2a scope decision verbatim — the scope label, the in-scope AC bullets, the deferred bullets, and the follow-on task IDs — so a future reader sees exactly what was deferred and why.

Verdict stays **`PARTIAL`** inside `verification_evidence` — verdict honesty is preserved, the orchestrator NEVER upgrades. Only `status` moves to `done`. Verdict and status are decoupled deliberately: the verdict reflects what the verifier could observe in this attempt; the status reflects whether the orchestrator considers the task complete relative to its **declared scope** (the §2a annotation).

Note: creating the follow-on task in step 2 of this carve-out is a deliberate exception to the "Don't create new tasks during the loop" rule under Important Rules — the new task is the entire mechanism that makes this closure honest, so it MUST be permitted here.

**Cross-reference: this carve-out closes the loop opened by the post-#320 orchestrator-upgrade hardening (commit `6b26fc5`).** It is NOT a verdict upgrade — `verdict: "PARTIAL"` is preserved in `verification_evidence` exactly as the verifier emitted it. The orchestrator is making a *status* decision (done vs in_progress) based on the declared-scope contract from §2a + §7a, while the verdict accurately reflects what the verifier could grade. Without §2a's `scope:` annotation upstream, this carve-out does NOT apply and the default PARTIAL branch (task stays `in_progress`) is the only path.

```
wood-fired-tasks:add_comment with task_id=<id>, author=<agent>, content=
  "Verifier verdict: PARTIAL (declared scope: <label>).\n\n§2a scope decision: <verbatim quote of scope label + in-scope bullets + deferred bullets>.\n\nFollow-on tasks tracking deferred runtime ACs: #<id_1>, #<id_2>.\n\nIn-scope ACs the verifier could not observe (acknowledged as deferred, not blocking closure):\n- <check.name>: <check.evidence_url_or_text>\n- ..."
wood-fired-tasks:update_task with id=<id>, updates={
  "status": "done",
  "verification_evidence": <full evidence object — verdict stays PARTIAL>
}
```

---

## §F. `.flaky-tests.json` handling

**Called from:** `loop.md` §2c (Baseline the test suite — known-flake exclusions), `loop-dag.md` §2 (reuses `loop.md` §2c verbatim).

Repos with chronically flaky tests (timing-sensitive E2E, network-dependent integration) opt in to first-class flake handling by committing a `.flaky-tests.json` at the repo root. The orchestrator MUST read `<each-baselined-repo>/.flaky-tests.json` (if present) and feed the listed tests into the `known_flakes` field that §2c records per repo — this is the canonical SOURCE for `known_flakes`, superseding ad-hoc user-confirmed flakes from the previous sub-block when both exist (union the two sets; the file is authoritative for the listed names).

Schema (versioned envelope, one entry per known flake):

```json
{
  "version": 1,
  "tests": [
    {
      "fqn": "Namespace.ClassName.TestMethodName",
      "reason": "one-line description of why this test is flaky",
      "filed_at": "2026-05-24",
      "tracking_issue": "#123 or https://github.com/org/repo/issues/123"
    }
  ]
}
```

Per-runner filter syntax for excluding ONE test by FQN (the orchestrator selects based on the repo's stack detected in §2b):

| Runner | Exclude-by-FQN flag |
|---|---|
| xunit-v3 MTP (`dotnet run --project ... -- ...`) | `--filter-not-method <FQN>` (repeat per test) |
| xunit-v1/v2 / `dotnet test` | `--filter "FullyQualifiedName!=<FQN>"` (join with `&` for multiple) |
| vitest | `--exclude '<file-or-pattern>'` (use the `fqn`'s file path; or `-t '!<test name>'` for name-based) |
| pytest | `-k 'not <test_name> and not <other>'` (join with `and not`) |
| jest | `--testPathIgnorePatterns='<pattern>'` or `-t '^(?!<name>).*$'` for name-based |

**Auto-application rule.** When `.flaky-tests.json` is present in a baselined repo, the orchestrator MUST:

1. Parse it once during §2c baselining; reject malformed JSON or `version != 1` and surface to the user (do NOT proceed with a half-parsed file).
2. Populate that repo's `known_flakes: [...]` field in the per-repo baseline record (from the `fqn` of every entry).
3. Apply the runner's exclude-by-FQN flag to BOTH the §2c baseline run AND the Step 5 post-edit re-run for that repo, so the same tests are suppressed end-to-end. This is the load-bearing guarantee: the baseline numbers the close-out cites and the post-edit numbers the verifier sees are produced under the same exclusion filter.
4. Record the exclusion list verbatim in the orchestrator's mental notes / cache file (`.tasks-loop-memo.md`) so every Step 4 subagent brief for that repo carries the same list.

**Candidate-for-promotion rule.** If the orchestrator detects (via an optional unfiltered re-run, OR via observation across multiple loop iterations) that a test listed in `.flaky-tests.json` PASSED consistently throughout this loop run, surface it in the Step 8 close-out comment under `**Candidate-for-promotion:**` so the user can remove the entry from the file. Do NOT auto-edit `.flaky-tests.json` — promotion is a human decision.

**Reinforcement of the existing pre-existing-breakage policy.** A test that is NOT in `.flaky-tests.json` but FAILS in the §2c baseline still triggers the existing policy from the top of §2c (steps 1–3): surface the failure to the user, offer housekeeping-fix-first or abort, do NOT start the loop until green. `.flaky-tests.json` is opt-in suppression for KNOWN flakes only — it does not silence unknown failures.

---

## §G. Verifier parse-failure patterns

**Called from:** `loop.md` §7c (Parse + validate the verifier's output), `loop-dag.md` §3d (Verify each worker via tasks-verifier — same parse + repair contract).

The verifier model frequently emits semantically-correct findings inside a schema-violating envelope. The `VerificationEvidenceSchema` is `.strict()` (extra keys rejected) and pins specific field names, so several emission patterns parse-fail despite the underlying judgment being sound. Silently dropping a verifier's real findings is forbidden — the orchestrator MUST attempt repair via `SendMessage` to the SAME verifier session (which §7b mandates was dispatched with a `name:`) before falling through to `NOT_VERIFIED`. The session retains its tool-call evidence and check decisions, so a tight diagnostic flips the shape without re-doing the work.

Known parse-failure patterns and the diagnostic to send (one per failure class):

1. **`status: "PARTIAL"` on a per-check entry** — enum violation. The schema's `checks[i].status` is `PASS | FAIL | SKIP` only; `PARTIAL` is a top-level `verdict` value only. Diagnostic: `"you emitted status: \"PARTIAL\" on check N — that's invalid (enum is PASS|FAIL|SKIP). Re-emit with status: \"SKIP\" and evidence_url_or_text starting UNCHECKABLE: <reason>, then recompute the top-level verdict per the rollup table."`

2. **Wrong per-check field name** — most often `criterion` instead of `name` (observed in Wave 11 / #332). The schema requires `name: string` (1-200 chars), `status`, and `evidence_url_or_text`. Diagnostic: `"per-check field name mismatch — schema requires name (not criterion / description / title). Rename the field for every check and re-emit."`

3. **Extra strict-mode fields rejected** — top-level keys like `task_id`, `notes`, `summary`, or per-check keys like `artifacts`, `tags`, `confidence`. The schema is `.strict()` — only the documented keys parse. Diagnostic: `"VerificationEvidenceSchema is .strict(); your envelope has unknown keys: <list>. Drop them and re-emit. Top-level allowed: verdict, checks, verifier_session_id, verifier_request_id, verified_at. Per check allowed: name, status, evidence_url_or_text."`

4. **Missing required field** — most often `evidence_url_or_text` omitted on a check, or `verdict` missing at top level. Diagnostic: `"check N is missing required field <name> — schema requires it on every check (max 2000 chars). Add the evidence citation and re-emit."`

5. **Malformed JSON** — markdown fence, prose preamble, trailing commentary, unescaped quotes. Diagnostic: `"your output wasn't parseable as a single JSON object — fence/preamble/trailing prose detected. Re-emit ONLY the JSON object as your final message, no fence, no prose."`

For each pattern, the orchestrator sends `SendMessage(to: "verifier-task-<id>", message: <diagnostic>)` and re-parses the new final message. Cap auto-repair at **2 SendMessage round-trips per verifier session** — if the second repair still fails to parse, synthesize NOT_VERIFIED and stop. Beyond two attempts the verifier is genuinely broken and further repair is throwing tokens at the wall.

---

## §H. Declared scope narrowing detection

**Called from:** `loop.md` §2a (Read the project's domain spec doc(s) — declared scope narrowing detection sub-block), `loop-dag.md` §2 (reuses `loop.md` §2a verbatim).

A task's *intent* may be narrower than its acceptance-criteria text suggests. Two precedents:

- Wave 5 / #320 (`/tasks:decompose`) landed deliberately as **design-only**: a full design contract + schemas + falsifiable test gates, with runtime implementation deferred to a documented follow-on task. The AC text described runtime behaviour, but the intent was the design spec.
- Wave 7.1 / #323 (`/tasks:audit`) followed the same pattern.

When the orchestrator decides at planning time (Step 3) to narrow scope — most often to design-only, but the same applies to "slice-of-epic" landings where only a subset of bullets are actually attempted in this iteration — it MUST record the scope decision as a `scope:` annotation against that task in the SAME mental notes / cache file used by the sibling-repo scan. The annotation records:

- (a) the **scope label** (e.g. `scope: design-only`, `scope: slice-of-epic`),
- (b) which AC bullets are **in-scope** for THIS attempt (verbatim copy of the bullet text — quoting matters; the verifier will be graded against this exact list in Step 7a),
- (c) which AC bullets are **out-of-scope / deferred** to runtime follow-on,
- (d) **where the follow-on tasks are tracked** — existing task IDs if they already exist, or the literal string `to be created at close-out` if the follow-on tasks will be opened during the §7d carve-out.

Detection signals — these are the orchestrator's *planning judgment cues*, NOT auto-classification triggers:

- The AC text uses runtime-y verbs ("Dispatches X", "Produces Y", "Runs against Z") BUT the task is part of a wave-numbered epic whose prior peers landed design-only (e.g. #320 sets the precedent for #323).
- The AC's own verification step requires runtime infrastructure that does not yet exist.
- The AC explicitly contains a "FOLLOW-UP TASKS", "DEPS", or "RUNTIME DEFERRED TO" note pointing at a separate implementation task.

The orchestrator MUST NOT silently narrow scope. The decision is logged twice: once in the orchestrator's close-out comment for the audit trail, and — more importantly — the narrowed AC set is passed to the verifier in Step 7a so the verifier grades only what's in-scope for this attempt. Cross-reference: this annotation is the prerequisite for the Step 7d "declared scope narrowing closes the task" carve-out — without it, the carve-out does NOT apply.

---

## §I. Step 8 close-out comment template

**Called from:** `loop.md` §Step 8 (Close the task), `loop-dag.md` §3d PASS branch (close-out comment per `loop.md` §Step 8 template).

```
Resolved.

**Tooling / approach pick:** <if a choice was made — and why>.

**Changes:**
- <file>: <one-line per-file rationale>
- ...

**Disabled / deferred (each a future task in this project):**
- <rule / flag / feature> — reason.

**Validation (independently re-run by orchestrator):**
- <command>: <pass/fail + headline numbers>
- ...

**Flake exclusions:** <N excluded from <repo> via `.flaky-tests.json`> _(always present when the union of `known_flakes` across baselined repos was non-empty; omit otherwise)_

**Candidate-for-promotion:** <list of `.flaky-tests.json` entries that passed consistently across this loop run — user may remove from the file> _(only present when N > 0)_

**Commit:** `<hash>` <subject>
```

---

## §J. Step 5 inline orchestrator post-correction carve-out

**Called from:** `loop.md` §Step 5 item #6 (Verify the subagent's claim — narrow carve-out for inline post-correction).

The default rule (Step 5 item #5) is: validation regressions go back to the subagent via `SendMessage`, never inline-patched by the orchestrator. This carve-out is the one exception. The orchestrator MAY apply a mechanical fix in-context, without a SendMessage round-trip, when **ALL of** the following hold (conjunctive — miss one, dispatch a subagent):

- The issue was discovered by the orchestrator itself **during Step 5 verification** (not by delegated quality, not by the verifier in Step 7, not by user feedback).
- The fix is **purely mechanical**: a `git mv`, a path-string update, a missing trailing newline, a `.gitignore` addition, or a typo in commit-ready prose.
- The fix **does not alter any logic, data, or executable behavior** — diff is reviewable end-to-end without running code.
- The orchestrator would need to read **≤ 2 files** to make the change.

**Anti-criteria — still require subagent dispatch even if the four conditions look met:**

- Any change to source code (`.cs`, `.ts`, `.py`, `.js`, etc.).
- Any change to test files.
- Any change to acceptance-criteria-bearing artifacts (the schema doc itself, not its pointer).

When the carve-out fires, the inline fix MUST be documented in the Step 8 close-out comment under a separate **"Orchestrator post-correction:"** bullet so the audit trail is preserved. (Context: the 2026-05-23 #313 path-correction incident — a 2-line `git mv` + path-string Edit was force-routed through a SendMessage round-trip, costing ~3 minutes for zero quality gain.)

## §K. Harness TodoWrite preload (TaskCreate + TaskUpdate + TaskList bundling)

> **Why this section exists.** F9 friction finding from the 2026-05-24 `/tasks:loop-dag` first-use audit: in Claude Code's deferred-tool model, `TaskCreate` (the in-conversation TodoWrite-family create-todo tool) is auto-promoted by the harness in some contexts, but `TaskUpdate` and `TaskList` are typically deferred and require a separate `ToolSearch` round-trip to load before they're callable. The pairing is asymmetric — you can create a todo and then discover you can't mark it `in_progress` / `completed` without another round-trip. Tracked in [task #352](https://github.com/Wood-Fired-Games/wood-fired-tasks/) (this project).

**Rule for orchestrator skills (this skill, `/tasks:loop`, `/tasks:loop-dag`, and any future sibling that uses TodoWrite-family tooling):** load the trio in a single preflight `ToolSearch` rather than one-by-one. The canonical incantation:

```
ToolSearch with query "select:TaskCreate,TaskUpdate,TaskList"
```

Run this once near the top of the orchestrator turn (alongside any wood-fired-tasks MCP loads). The trio is small — loading all three costs almost nothing — and avoids the cache-miss penalty of discovering the dependency mid-run when you've already minted a todo and need to flip its status.

**For skills that only READ todos** (rarer — e.g. a status-check helper), load `TaskList` alone:

```
ToolSearch with query "select:TaskList"
```

**For skills that only WRITE todos without follow-up updates** (rarer still — e.g. a one-shot capture into TodoWrite from another tool's output): load `TaskCreate` alone. But prefer the bundled trio unless you're certain follow-up isn't needed.

**Upstream-issue status:** the asymmetric promotion is a Claude Code harness concern, not actionable from a wood-fired-tasks skill. File a feedback note at <https://github.com/anthropics/claude-code/issues> if you hit it (suggested title: "TaskUpdate not auto-promoted alongside TaskCreate — extra ToolSearch round-trip required"). Until that lands, this bundling rule is the workaround.
