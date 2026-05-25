Owner: Repository maintainers

# tests/verifier-fixtures/

Hand-crafted scenarios that exercise the `tasks-verifier` contract at
[`docs/verifier-contract.md`](../../docs/verifier-contract.md). Three
fixtures cover the three rollup paths the verifier produces:

| Scenario                                                      | Worker behaviour                                       | Expected verdict |
|---------------------------------------------------------------|--------------------------------------------------------|------------------|
| [`scenario-1-real-pass/`](scenario-1-real-pass/)              | Implemented every criterion with verifiable evidence.  | `PASS`           |
| [`scenario-2-false-pass-lying-worker/`](scenario-2-false-pass-lying-worker/) | Closed the task without doing the work (red-team).     | `FAIL`           |
| [`scenario-3-partial-work/`](scenario-3-partial-work/)        | Did some criteria, missed others.                      | `PARTIAL`        |

## Fixture format

Each subdirectory contains:

- `input.json` — a plausible `VerifierInputs` envelope. Field shapes:
  ```ts
  { task_id: number, acceptance_criteria: string,
    worker_subagent_session_id: string,
    commit_shas: string[], file_changes: string[] }
  ```
- `expected.json` — the `VerificationEvidence` envelope the verifier
  should produce. Validated against `VerificationEvidenceSchema` at
  `src/schemas/task.schema.ts` by
  `src/api/routes/tasks/__tests__/verifier-fixture-shapes.test.ts`.
- `README.md` — short prose description of the scenario.

## Status

These fixtures are **contract examples**, not live-dispatched test
inputs. The programmatic guarantee is that every `expected.json` parses
against the storage-layer zod schema, so anything the verifier emits
matching one of these shapes will round-trip cleanly through
`PUT /tasks/:id`. Wave 2.2 (task #315) will wire `/tasks:loop` to
dispatch the verifier subagent against real task closures.

## Manually dispatching the verifier on a fixture

```text
1. Open Claude Code in the wood-fired-tasks repo.
2. Use the Task tool with subagent_type="tasks-verifier".
3. Pass the contents of <fixture>/input.json as the prompt body.
4. Compare the verifier's final JSON message against <fixture>/expected.json.
```

The fixtures use placeholder commit SHAs and file paths — they will not
match the live repo state. The check is on the shape and rollup logic
of the verifier's output, not on the verifier successfully running
`git show` against fake SHAs.
