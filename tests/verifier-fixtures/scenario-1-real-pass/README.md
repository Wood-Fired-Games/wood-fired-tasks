Owner: Repository maintainers

# Scenario 1 — real PASS

The worker implemented every acceptance criterion:

- Created `src/utils/slug.ts` with the required signature and behaviour.
- Added unit tests covering the three named cases.
- Committed the changes (two commits, both in `commit_shas`).
- `npm test` exits 0 with no regressions.

Every criterion is observably satisfied via file:line or command-output
evidence. The verifier produces four `PASS` checks and rolls up to
`verdict: "PASS"`.

This fixture is the "happy path" baseline. If the verifier ever returns
anything other than `PASS` for an input shaped like this, the rollup
logic in the agent prompt is broken.
