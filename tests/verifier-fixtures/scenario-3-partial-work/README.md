Owner: Repository maintainers

# Scenario 3 — partial work

The worker satisfied the implementation criteria but left two
criteria the verifier cannot observe within bounds:

- Implementation criteria 1-3 (file exists, function behaves correctly,
  unit tests present) → all `PASS`.
- Criterion 4 (`docs/SETUP.md` mentions the helper) → `SKIP` +
  `UNCHECKABLE:` because the doc may already mention it from a prior
  commit on main, and disambiguating within the 30-call budget is not
  worth the spend.
- Criterion 5 (manual UAT against the admin dashboard) → `SKIP` +
  `UNCHECKABLE:` because UAT is human-only.

Rollup: no `FAIL`, mix of `PASS` and `SKIP`-UNCHECKABLE → `verdict:
"PARTIAL"`. This is the canonical example of "verifier did its job but
the criteria themselves are not fully machine-checkable" — the
orchestrator surfaces PARTIAL so a human can resolve the UNCHECKABLE
checks before marking the task fully verified.
