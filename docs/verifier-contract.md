Owner: Repository maintainers

# tasks-verifier subagent contract

> Wave 2.1 (task #314). Defines the input/output contract, tool surface,
> and bounds for the `tasks-verifier` subagent dispatched by
> `/tasks:loop` after each worker subagent closes a task.

## Purpose

Independent grader. After a worker subagent closes a task, the orchestrator
dispatches the `tasks-verifier` subagent against the same task with **no
access to the worker's context**. The verifier reads the acceptance criteria,
inspects the working tree and commit history the worker produced, and emits
a structured PASS/FAIL/PARTIAL verdict with cited evidence per check.

The verifier exists to catch:

- **Lying workers** — closed the task without doing the work.
- **Partial workers** — implemented some criteria, skipped others.
- **Collateral-damage workers** — fixed the requested criterion but broke
  unrelated tests / lint / build.
- **Cargo-cult workers** — touched files unrelated to the criteria and
  produced a closing commit that does not move the work forward.

The verifier uses **goal-backward analysis**: it starts from the goal
(acceptance criteria) and walks backward to the evidence (file content,
test output, commit diff). It never starts from the diff and rationalises
why it satisfies the goal.

## Inputs

The orchestrator calls the verifier with a single JSON object:

```ts
interface VerifierInputs {
  /** Numeric wood-fired-tasks task id (e.g. 314). */
  task_id: number;

  /**
   * The acceptance_criteria column for `task_id`, verbatim. Plain markdown.
   * If the task has no acceptance_criteria the orchestrator MUST NOT
   * dispatch the verifier — there is nothing to grade against.
   */
  acceptance_criteria: string;

  /**
   * Session identifier of the worker subagent that closed the task.
   * Recorded in the output as `verifier_session_id` is to the verifier:
   * a stable handle the orchestrator can use to correlate logs.
   * Opaque to the verifier; never used to fetch the worker's transcript.
   */
  worker_subagent_session_id: string;

  /**
   * Commit SHAs produced by the worker, in chronological order.
   * Used to scope `git log` / `git show` / `git diff` evidence queries.
   * MAY be empty if the worker claimed done without committing — the
   * verifier MUST treat that as a strong negative signal.
   */
  commit_shas: string[];

  /**
   * Paths the worker reported as modified, relative to repo root.
   * Used to scope `Read` / `Grep` evidence queries. MAY be empty.
   * The verifier MUST NOT trust this list as proof the file changed —
   * always cross-check with `git diff` / `git show`.
   */
  file_changes: string[];
}
```

Example:

```json
{
  "task_id": 314,
  "acceptance_criteria": "- Contract doc committed.\n- Subagent definition file uses only read-only tools.\n- A lying-worker red-team fixture produces verdict=FAIL.",
  "worker_subagent_session_id": "sess_worker_2026_05_23_abc",
  "commit_shas": ["a1b2c3d4e5f6"],
  "file_changes": [
    "docs/verifier-contract.md",
    "skills/agents/tasks-verifier.md",
    "tests/verifier-fixtures/README.md"
  ]
}
```

## Outputs

The verifier MUST emit, as its final message, a single JSON object that
matches the `VerificationEvidence` shape at
[`src/types/task.ts:47`](../src/types/task.ts) (`VerificationCheck` at
`:41`; authoritative zod
schema: [`src/schemas/task.schema.ts` → `VerificationEvidenceSchema`](../src/schemas/task.schema.ts)):

```ts
interface VerificationEvidence {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'NOT_VERIFIED';
  checks?: Array<{
    name: string;
    status: 'PASS' | 'FAIL' | 'SKIP';
    evidence_url_or_text: string;
  }>;
  verifier_session_id?: string;   // Verifier's own subagent session id.
  verifier_request_id?: string;   // Orchestrator-supplied request id, echoed back.
  verified_at?: string;           // ISO8601 timestamp recorded by the verifier.
}
```

Bounds enforced by the storage-layer schema:

- `checks` capped at 50 entries.
- `evidence_url_or_text` capped at 2000 characters.
- Identifier strings (`verifier_session_id`, `verifier_request_id`) capped
  at 200 characters.

### ⚠ Two enums — do NOT conflate

The top-level `verdict` and the per-check `status` are SEPARATE enums:

| field                       | allowed values                                  | `PARTIAL` allowed? |
|-----------------------------|-------------------------------------------------|--------------------|
| `verdict` (top-level)       | `PASS` \| `FAIL` \| `PARTIAL` \| `NOT_VERIFIED` | YES (derived)      |
| `checks[i].status` (per check) | `PASS` \| `FAIL` \| `SKIP`                   | **NO**             |

A check's `status` is **never** `PARTIAL`. `PARTIAL` only appears at the
top level as a *derived* verdict when the rollup table (below) sees a
check population that mixes `PASS` + `SKIP`. Use `status: "SKIP"` with
`evidence_url_or_text` starting `UNCHECKABLE: <reason>` for criteria the
verifier could not observe — never `status: "PARTIAL"`. A `status:
"PARTIAL"` will fail `VerificationEvidenceSchema.safeParse(...)`, and
the orchestrator will then treat the entire run as `NOT_VERIFIED`.

Wrong (rejected by schema):

```json
{ "name": "live DB smoke", "status": "PARTIAL", "evidence_url_or_text": "couldn't observe" }
```

Right (the verifier observed it cannot observe, and emits SKIP +
UNCHECKABLE):

```json
{ "name": "live DB smoke", "status": "SKIP", "evidence_url_or_text": "UNCHECKABLE: read-only verifier cannot invoke the live DB." }
```

Example PASS output:

```json
{
  "verdict": "PASS",
  "checks": [
    {
      "name": "Contract doc committed",
      "status": "PASS",
      "evidence_url_or_text": "docs/verifier-contract.md:1 — file present at HEAD (git show HEAD:docs/verifier-contract.md returned 240 lines)."
    },
    {
      "name": "Subagent definition uses only read-only tools",
      "status": "PASS",
      "evidence_url_or_text": "skills/agents/tasks-verifier.md:4 — tools: Read, Grep, Glob, Bash, mcp__wood-fired-tasks__get_task, mcp__wood-fired-tasks__get_comments, mcp__wood-fired-tasks__get_dependencies, mcp__wood-fired-tasks__list_tasks, mcp__wood-fired-tasks__list_projects (no Edit/Write/MultiEdit/NotebookEdit)."
    }
  ],
  "verifier_session_id": "sess_verifier_2026_05_23_xyz",
  "verified_at": "2026-05-23T20:14:07.000Z"
}
```

## Verdict rollup rules

Compute the top-level `verdict` deterministically from the per-check
`status` values:

| Check population                                       | `verdict`      |
|--------------------------------------------------------|----------------|
| At least one `FAIL`                                    | `FAIL`         |
| No `FAIL`, all remaining are `PASS`                    | `PASS`         |
| No `FAIL`, mix of `PASS` and `SKIP` (UNCHECKABLE)      | `PARTIAL`      |
| No `FAIL`, all `SKIP` (UNCHECKABLE)                    | `PARTIAL`      |
| Zero checks emitted                                    | `NOT_VERIFIED` |

`NOT_VERIFIED` is reserved for the service-layer auto-materialization
when a task closes without any verifier ever running. The verifier itself
SHOULD NOT emit `NOT_VERIFIED` — if there is no observable evidence at
all the verifier emits `PARTIAL` with every check marked `SKIP`
(UNCHECKABLE), so the orchestrator can tell "verifier ran and found
nothing checkable" from "no verifier ran".

## UNCHECKABLE handling

The task spec uses the word **UNCHECKABLE** for criteria the verifier
cannot observe (no file path mentioned, no test exists, evidence requires
human judgement). The storage-layer `VerificationCheck.status` enum only
allows `PASS | FAIL | SKIP`, so UNCHECKABLE maps to:

- `status: "SKIP"`, AND
- `evidence_url_or_text` MUST start with the literal prefix `UNCHECKABLE:`
  followed by a one-sentence reason.

Example:

```json
{
  "name": "Worker did not regress unrelated tests",
  "status": "SKIP",
  "evidence_url_or_text": "UNCHECKABLE: no test suite available within bounds; would require >30 tool calls to run npm test."
}
```

Rollup rule stays the same: any `SKIP`-with-`UNCHECKABLE:` prefix and no
`FAIL` produces overall `verdict: "PARTIAL"`. The orchestrator MAY treat
`SKIP` without the `UNCHECKABLE:` prefix as a verifier bug and refuse to
record the evidence.

## Evidence format

Every `evidence_url_or_text` MUST be one of:

1. **file:line citation** — `path/to/file.ts:42 — <one-line excerpt or paraphrase>`.
   Path is relative to repo root. Line number is the line the evidence
   appears on, not a range start.
2. **Test command + stdout snippet** — `$ <command>\n<stdout excerpt>`.
   The command MUST be one of the allowlisted Bash tools below. Excerpt
   trimmed to the smallest fragment that proves the assertion.
3. **`tasks scm` citation** — a `tasks scm` READ-verb result excerpt:
   `tasks scm change-id` (`data.ids`), `tasks scm changed-files <base>`
   (`data.files[].path`), `tasks scm baseline` (`data.id`), or
   `tasks scm status` (`data.entries[].path`).
4. **UNCHECKABLE:** prefix, as above, for criteria the verifier cannot
   observe within bounds.

Hand-wavy text ("looks good", "appears to satisfy the requirement",
"the worker says it's done") is FORBIDDEN. Evidence that does not cite
a file, command, or commit MUST be downgraded to `SKIP` + `UNCHECKABLE:`.

## Tool allowlist

The verifier subagent is read-only. The frontmatter `tools:` list at
`skills/agents/tasks-verifier.md` MUST be exactly:

- `Read` — inspect file contents.
- `Grep` — search file contents.
- `Glob` — enumerate files matching a pattern.
- `Bash` — restricted to the commands below.
- `mcp__wood-fired-tasks__get_task` — read-only task lookup.
- `mcp__wood-fired-tasks__get_comments` — read-only comment lookup.
- `mcp__wood-fired-tasks__get_dependencies` — read-only dependency lookup.
- `mcp__wood-fired-tasks__list_tasks` — read-only list query.
- `mcp__wood-fired-tasks__list_projects` — read-only project list.

Bash commands the verifier MAY invoke:

- `tasks scm baseline` (read-only — the worktree's integration baseline id; `data.id`)
- `tasks scm change-id` (read-only — the recorded change-ids; `data.ids`)
- `tasks scm changed-files <base>` (read-only — changed paths vs a baseline id; `data.files[].path`)
- `tasks scm status` (read-only — working-tree dirty state; `data.entries[].path`)
- `tasks scm detect` (read-only — the resolved backend + behaviors)
- `npm test`
- `npm run lint`
- `npm run build`
- `vitest run --reporter=basic`
- `cat`, `head`, `tail`, `wc -l`
- `find`, `ls`
- `sqlite3 <db> '<SELECT-only query>'` — SELECT queries only, never
  INSERT / UPDATE / DELETE / DROP / ATTACH.

## Tool denylist

The verifier subagent MUST NOT invoke any of:

- `Edit`, `Write`, `MultiEdit`, `NotebookEdit` — code mutation.
- `npm install`, `npm ci`, `git commit`, `git push`, `git checkout`,
  `git reset`, `git rebase`, `mv`, `rm`, `chmod`, `chown` — state mutation.
- Any wood-fired-tasks MCP tool that mutates state: `update_task`,
  `add_comment`, `delete_comment`, `claim_task`, `create_task`,
  `create_project`, `update_project`, `delete_project`, `delete_task`,
  `add_dependency`, `remove_dependency`, `completion_report` writes.
- Any MCP tool from a non-wood-fired-tasks server (defence-in-depth — the
  verifier has no business calling external services).

The frontmatter `tools:` list at `skills/agents/tasks-verifier.md`
enforces this by enumeration: tools not in the allowlist are not
available to the subagent at all.

## Bounds

The verifier subagent operates within hard bounds. The orchestrator MUST
stop the verifier if either bound is exceeded and treat the run as
`verdict: "PARTIAL"` with a final SKIP-UNCHECKABLE check noting the
bound that triggered.

- **≤ 30 tool calls** total across the run.
- **≤ 5 minutes** wall-clock time.

The verifier subagent itself SHOULD self-throttle: if it has used 25
tool calls and has not yet started rolling up checks, it must stop
investigating and emit the partial output it has.

## Failure modes the verifier MUST catch

1. **Lying worker** — `commit_shas` is empty OR `git show <sha>`
   reveals only whitespace / comment-only changes. Every criterion that
   references a file the worker did not touch → `FAIL`.
2. **Partial worker** — some criteria satisfied, others not. Emit a
   mix of `PASS` + `FAIL` (preferred) or `PASS` + `SKIP`-UNCHECKABLE
   (when the verifier itself cannot observe).
3. **Collateral-damage worker** — criteria satisfied, but `npm test`
   exits non-zero on unrelated tests. Add a synthetic check
   `"No regressions in pre-existing tests"` with `status: "FAIL"` and
   the failing test name in evidence.
4. **Cargo-cult worker** — criteria reference `docs/foo.md` but the
   worker only touched `src/bar.ts`. Mark the criterion `FAIL` with
   evidence `git show <sha> --stat | grep docs/foo.md → empty`.

## Reference fixtures

Hand-crafted scenarios used to validate the contract:

- [`tests/verifier-fixtures/scenario-1-real-pass/`](../tests/verifier-fixtures/scenario-1-real-pass/)
  — real work, expected verdict=PASS.
- [`tests/verifier-fixtures/scenario-2-false-pass-lying-worker/`](../tests/verifier-fixtures/scenario-2-false-pass-lying-worker/)
  — red-team case, expected verdict=FAIL.
- [`tests/verifier-fixtures/scenario-3-partial-work/`](../tests/verifier-fixtures/scenario-3-partial-work/)
  — partial implementation, expected verdict=PARTIAL.

Each fixture directory contains:

- `input.json` — the `VerifierInputs` envelope.
- `expected.json` — the `VerificationEvidence` envelope the verifier
  should produce (schema-validated by
  `src/api/routes/tasks/__tests__/verifier-fixture-shapes.test.ts`).
- `README.md` — one-paragraph description of the scenario.

The fixtures are contract examples, not live-dispatched test inputs.
Wave 2.2 (task #315) wires `/tasks:loop` to dispatch the verifier
subagent against real task closures.
