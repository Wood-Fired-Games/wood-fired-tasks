# Contributing

Thanks for your interest in contributing to wood-fired-bugs. See `README.md` for
setup and architecture. The notes below cover quality gates that are easy to
miss.

## Mutation testing policy

We use [Stryker](https://stryker-mutator.io/) to verify that our test suite
actually fails when production code is mutated (a strong "tests assert
something useful" signal that line/branch coverage cannot give).

- **Current break threshold:** `50` (mutation score below 50% fails CI).
- **Where:** `stryker.config.js` (`thresholds.break`).
- **When CI runs it:** nightly (06:00 UTC), on `workflow_dispatch`, and on any
  PR labeled `mutation`. It is intentionally NOT part of the default PR check
  matrix because a full run takes 20-45 minutes.
- **Plan to raise it:** the `50` baseline is conservative for first enforcement.
  Once we have a few clean nightly runs we will raise to `60`, then `75` to
  match the `low: 60 / high: 80` reporting thresholds already in the config.
- **Running locally:** `npm run test:mutation`. The HTML report is written to
  `reports/mutation/` and is uploaded as the `mutation-report` artifact in CI.
