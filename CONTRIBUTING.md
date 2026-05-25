# Contributing to wood-fired-tasks

Thanks for your interest in contributing! This document describes how to get
set up, what we expect in PRs, and the quality gates that gate merges.

## Welcome / Overview

`wood-fired-tasks` is a network-wide task tracking system with three surfaces:

- A **REST API** (Fastify) — see `docs/API.md`.
- A **CLI** (`tasks ...`) — see `docs/CLI.md`.
- An **MCP server** that exposes tasks to AI assistants — see `docs/MCP.md`.

We welcome external contributions that fit the project's scope:

- Bug fixes with regression tests.
- Documentation improvements and clarifications.
- New MCP tools that compose existing API operations.
- Additional CLI subcommands.
- Test coverage improvements (unit, integration, property-based).
- Performance and resilience fixes that come with benchmarks or load tests.

Large architectural changes should be discussed in a GitHub issue first so
we can confirm fit before you spend a lot of time.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold its standards. Report unacceptable
behavior to the maintainers via the contact listed in `CODE_OF_CONDUCT.md`.

## Security

**Do not file public GitHub issues for security vulnerabilities.** Report
them privately by following the process in [`SECURITY.md`](./SECURITY.md).
The maintainers will acknowledge receipt, investigate, and coordinate a
fix and disclosure timeline with you.

If you discover a vulnerability while preparing a PR, stop, contact the
maintainers privately, and we will work with you on a coordinated patch.

## Getting Started

### Prerequisites

- **Node.js 22+** (LTS recommended). The CI matrix pins to Node 22.
- **npm** (ships with Node).
- **git**.

### Clone and install

```bash
git clone https://github.com/<org>/wood-fired-tasks.git
cd wood-fired-tasks
npm ci
npm test
```

`npm ci` produces a clean, lockfile-faithful install. `npm test` should
pass against a freshly-cloned checkout — if it does not, that is itself a
bug worth reporting.

### Where the docs live

| Topic              | File             |
| ------------------ | ---------------- |
| REST API reference | `docs/API.md`    |
| CLI reference      | `docs/CLI.md`    |
| MCP integration    | `docs/MCP.md`    |
| Local setup        | `docs/SETUP.md`  |

Read `docs/SETUP.md` for environment variables, database location, and how
to run the API, CLI, and MCP server locally.

## Development Workflow

1. **Branch from `main`.** Use a descriptive branch name like
   `fix/task-list-pagination` or `feat/mcp-bulk-update`.
2. **Make atomic commits.** Each commit should be one logical change that
   builds and tests cleanly on its own. Prefer many small commits over one
   large catch-all.
3. **Use conventional commits** for the subject line, e.g.:
   - `fix(api): return 404 when project missing`
   - `feat(mcp): add bulk_update_tasks tool`
   - `docs(cli): clarify --status flag values`
   - `test(db): add migration rollback coverage`
   - `chore(deps): bump fastify to 5.8`
4. **Keep PRs small and focused.** One concern per PR. Refactors should be
   separate commits (or separate PRs) from behavior changes.
5. **Rebase, do not merge `main` into your branch.** Keep history linear.

## Testing

We use [Vitest](https://vitest.dev/). The test suite is the contract.

### Commands

```bash
npm test               # Single run (what CI runs)
npm run test:watch     # Watch mode for local iteration
npm run test:coverage  # Run with coverage report (./coverage/)
npm run test:bench     # Run benchmarks (excluded from npm test)
```

### What tests are required

- **Bug fixes:** a regression test that fails on `main` and passes with
  your fix.
- **New features:** unit tests for the new logic AND at least one
  integration test that exercises it through the public surface (HTTP
  route, CLI command, or MCP tool).
- **New MCP tools / CLI commands:** integration tests that invoke the
  tool/command end-to-end against a real (test-scoped) SQLite database.

### Where tests live

Tests live next to the code they exercise, named `*.test.ts`. Larger
integration tests live under `src/<area>/__tests__/`. Benchmarks live in
`*.bench.ts` files and are excluded from the default test run.

### Property tests

Property tests live in `**/__tests__/*.property.test.ts` and use
[`@fast-check/vitest`](https://github.com/dubzzz/fast-check/tree/main/packages/vitest).
Use them for invariants that should survive across many input variations —
state machines, idempotency, CAS protocols, cycle prevention, and
pagination/filter combinations. Property tests *complement* example-based
tests; they do not replace them. Keep `numRuns` tight (usually 5–20) so
the suite stays well under a second per file.

### Coverage thresholds

Coverage is enforced by Vitest via `vitest.config.ts`. Current minimums:

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | 85%       |
| Functions  | 85%       |
| Branches   | 75%       |
| Statements | 85%       |

These are baselines (ratcheted up by task #249) — please do not lower them.
Raise them when your change improves coverage materially.

## Quality Gates

Before opening a PR, run these locally:

```bash
npm run quality               # Composite: build, test, lint,
                              # lint:deps, depcruise, prod audit
```

The PR template's **Quality** and **Migration changes** checklists are
part of the review contract — authors must fill them in, and reviewers
must consider them when the corresponding surfaces are touched. See
[`docs/CODE_QUALITY_ROADMAP.md`](./docs/CODE_QUALITY_ROADMAP.md) for the
full quality contract and the "Ongoing Review Checklist" section.

Or run individual gates while iterating:

```bash
npm run build                 # Type-check / build (tsc)
npm test                      # Vitest with coverage thresholds
npm run lint                  # Biome lint
npm run lint:deps             # knip --dependencies
npm run depcruise             # Import boundaries + cycles
```

CI runs the same gates on every PR. If any fails, the PR cannot merge.

Note: `format:check` is intentionally **not** a gate today — Biome's
formatter is disabled in `biome.json` (`formatter.enabled=false`). A
separate task will enable it and land the one-time reformat sweep, at
which point `format:check` will be re-added to CI and `npm run quality`.
Running `npm run format:check` today will deliberately fail with an
explanatory message so the missing gate cannot masquerade as a green
check.

### Dependency audit policy

CI gates production dependencies only via
`npm audit --omit=dev --audit-level=high`. Dev-dependency audit is
**advisory, not gated** — running `npm audit` locally (no flags) surfaces
dev-dep advisories, which contributors should review at PR time but which
do not block CI. Dev deps do not ship in the published package, and gating
on dev-dep advisories produces frequent CI red without commensurate
user-facing risk.

### Architecture and Boundary Checks

`npm run depcruise` runs [dependency-cruiser](https://github.com/sverweij/dependency-cruiser)
over `src/` and enforces two things:

1. **No import cycles inside `src/`.** A new cycle is always an error.
2. **Layer boundaries** as documented in
   `docs/CODE_QUALITY_ROADMAP.md` Phase 4. The rule names map directly to
   the policy:
   - `leaves-no-upstream` — `src/db`, `src/types`, `src/schemas` must not
     import from entry-point or business-logic layers.
   - `repositories-layer` — `src/repositories` may only import `db`,
     `types`, `schemas`, `utils`, `config`, and other repositories.
   - `events-layer` — `src/events` may import `schemas`, `types`, `utils`,
     `config`; not entry points, services, or repositories.
   - `services-layer` — `src/services` must not import entry-point layers
     (`api`, `cli`, `mcp`, `slack`).

The config lives at `.dependency-cruiser.cjs`.

**If your PR fails the gate:**

1. Read the rule name in the failure output and find it in
   `.dependency-cruiser.cjs`. The `comment` field on each rule explains
   the policy in plain English.
2. In most cases the right fix is to move the import to the correct
   layer — e.g. importing a shared type from `src/types/` instead of
   reaching into a service. Apply the fix and re-run `npm run depcruise`.
3. If the violation is intentional (a deliberate architecture change),
   raise it in the PR before relaxing the rule. With reviewer sign-off,
   a layer rule may be downgraded from `severity: 'error'` to `'warn'`
   in `.dependency-cruiser.cjs` while the migration is in flight. The
   `no-circular` rule is not downgradable — cycles must be broken
   before merge.

`npm run depcruise:graph` writes a `dependency-graph.dot` file for
visual inspection (render with Graphviz). It is local-only — not wired
into CI.

### Mutation testing policy

We use [Stryker](https://stryker-mutator.io/) to verify that our test
suite actually fails when production code is mutated (a strong "tests
assert something useful" signal that line/branch coverage cannot give).

- **Current break threshold:** `75` (mutation score below 75% fails CI).
  Raised from `50 → 60 → 75` based on partial-run evidence (~86% sample
  score, ~79.7% pessimistic worst-case projection).
- **Where:** `stryker.config.js` (`thresholds.break`) — the local default.
  In CI the threshold is enforced post-aggregation against the unified
  score across all shards (see below).
- **When CI runs it:** nightly at 06:00 UTC (schedule), on
  `workflow_dispatch`, and on any PR labeled `mutation`.
- **Sharded design (task #252):** A full unsharded Stryker run was ~6h09m
  on the default ubuntu-latest runner (~7000 mutants), exceeding the 6h GH
  Actions ceiling. `.github/workflows/mutation.yml` now runs Stryker
  across **4 parallel matrix shards**, each restricted to a disjoint
  subset of `src/` via `--mutate` overrides:
  - shard 0 (`cli`) — `src/cli/**/*.ts`
  - shard 1 (`api-mcp`) — `src/api/**/*.ts`, `src/mcp/**/*.ts`
  - shard 2 (`services-db-repos`) — `src/services/**/*.ts`,
    `src/db/**/*.ts`, `src/repositories/**/*.ts`
  - shard 3 (`misc`) — `src/slack`, `src/schemas`, `src/events`,
    `src/utils`, `src/types`, `src/config`, `src/index.ts`

  Each shard uploads its `mutation.json` as artifact
  `mutation-shard-<id>-json`. A final `aggregate` job downloads every
  shard report, merges `files[].mutants[]` via
  `scripts/aggregate-mutation-reports.ts`, computes the unified score
  `(killed + timeout) / (killed + timeout + survived + noCoverage)`, and
  fails the workflow when the unified score is below the `75` threshold.
  The aggregator also writes `reports/mutation/aggregate.json` and pushes
  a summary to the GitHub Actions job summary.
- **Running locally:** `npm run test:mutation` runs Stryker against the
  full `src/` set (uses `stryker.config.js` directly — no sharding). The
  HTML report is written to `reports/mutation/`. Each shard's HTML report
  is also uploaded in CI as `mutation-shard-<id>-html`, plus the
  aggregated JSON as `mutation-aggregate`.
- **Adding files to a shard:** when a new top-level directory lands under
  `src/`, add its glob to the appropriate shard in the matrix in
  `.github/workflows/mutation.yml`. The aggregator does not care about
  partitioning — it merges whatever JSON arrives — but the shards must
  cover the same set of files that `stryker.config.js` mutates, otherwise
  the unified score will silently exclude them.

If your PR touches a hot module (anything under `src/api/`, `src/db/`,
`src/mcp/tools/`, or `src/cli/commands/`), consider labeling it
`mutation` so the nightly check runs against your branch before merge.

## Agent context maintenance

This repo ships a set of agent-facing context files so any AI assistant or
new human contributor can orient quickly after a fresh clone. Those files
are only useful if they stay accurate. The rules below describe when each
file must be updated, what belongs in your PR, and how the authoritative
vs. generated split works. Nothing here is vendor-specific — the rules
apply equally whether you use Claude, Cursor, Gemini, Codex, Copilot, or no
AI assistant at all.

### When to update each agent-facing file

| File                          | Update when                                                                                                                                                                                       | Authority                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `AGENTS.md`                   | Adding a new top-level surface, changing essential commands, changing the read-next intent table, or renaming a top-level directory in `src/`.                                                    | Authoritative              |
| `docs/AGENT_CONTEXT.md`       | Adding a new canonical doc, changing a size budget, changing the authority taxonomy or freshness rule, or changing the vendor-neutral boundary.                                                   | Authoritative              |
| `docs/REPO_MAP.md`            | Adding, renaming, or removing a top-level directory or a notable `src/` subtree.                                                                                                                  | Authoritative              |
| `docs/ARCHITECTURE.md`        | Changing a mutation flow (status transition matrix, claim semantics, idempotency window, event types), changing a layer boundary, or changing the auth model on any surface.                      | Authoritative              |
| `docs/WORKFLOWS.md`           | Adding, removing, or renaming an `npm` script; changing required env vars; or changing the focused-vs-full test guidance.                                                                         | Authoritative              |
| `docs/INTERFACES.md`          | Adding or removing a REST route, MCP tool, or CLI command. Update the per-surface table **and** the `Total: N` anchor; the drift test fails otherwise.                                            | Generated (verified by test) |
| `docs/NAVIGATION.md`          | Adding a new change-type recipe, or changing the implementation / test / docs paths for an existing recipe.                                                                                       | Authoritative              |
| `.agent-context.json`         | After editing `scripts/agent-context/manifest.ts` (path additions, status flips, budget changes). Regenerate with `npm run agent-context:gen`.                                                    | Generated                  |

### PR checklist for agent context impact

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) covers the general
Quality and Migration-changes checklists. The agent-context-specific items
below are not in that template — copy the relevant ones into your PR
description and tick the ones that apply.

- [ ] If this PR adds, removes, or renames a REST route, MCP tool, or CLI command, I updated `docs/INTERFACES.md` (per-row table + `Total: N` anchor) and ran `npm test` so the drift test stays green.
- [ ] If this PR changes a status transition, claim rule, event type, idempotency rule, or other behavior that crosses surfaces, I updated `docs/ARCHITECTURE.md`.
- [ ] If this PR adds a new top-level directory or renames a notable subtree, I updated `docs/REPO_MAP.md`.
- [ ] If this PR adds an `npm` script or changes a developer command, I updated `docs/WORKFLOWS.md`.
- [ ] If this PR adds a new canonical agent-facing doc, I added a row in the `docs/AGENT_CONTEXT.md` §2 table, classified it in §3, and gave it a size budget in §4.
- [ ] If this PR changes the canonical-files list, the size budgets, or the freshness rules, I updated `docs/AGENT_CONTEXT.md` and `AGENTS.md`'s deeper-docs table to match.
- [ ] If this PR edits `scripts/agent-context/manifest.ts` or any agent-facing doc, I ran `npm run agent-context:gen` and `npm run agent-context:check` and committed the regenerated `.agent-context.json`.
- [ ] If this PR adds a vendor-specific file (`CLAUDE.md`, `.cursor/`, `.gemini/`, `.codex/`, or any future `.<vendor>/`), it is either a thin pointer to `AGENTS.md` or vendor-only configuration with no unique project facts (per `docs/AGENT_CONTEXT.md` §6).

### Ownership and freshness expectations

All authoritative agent-facing files carry an `Owner:` line in their first
three lines (per the contract in `docs/AGENT_CONTEXT.md`). The value is a
role — `Owner: maintainers` or `Owner: docs` — not a person, so ownership
survives contributor turnover.

Hand-written authoritative files MUST stay under their declared line
budget. If the budget is exceeded, split the doc by linking to a new file
rather than growing the budget. Bigger files defeat the point: an agent
that has to read 800 lines to orient is back where it started.

Generated files MUST NOT be hand-edited. Their source is the corresponding
generator script under `scripts/`. Regenerate with
`npm run agent-context:gen` (or the appropriate script) and commit the
artefact alongside the source change in the same PR.

A forthcoming freshness CI check (tracked as a follow-up task) will
re-run the generator and fail PRs whose committed artefact drifts from
the regenerated content. Until that lands, contributors are responsible
for the manual run. `docs/INTERFACES.md` drift is *already* enforced by
`scripts/agent-context/__tests__/interfaces-counts.test.ts` — other drift
is not yet automated, so reviewers should spot-check it during review.

### Vendor-specific adapter review

If a PR adds or modifies a vendor-specific file (`.claude/`, `CLAUDE.md`,
`.cursor/`, `.gemini/`, `.codex/`, or any future `.<vendor>/`), reviewers
MUST check it against `docs/AGENT_CONTEXT.md` §6. The file MUST be either
(a) a thin pointer of the form `> See [AGENTS.md](AGENTS.md).` plus
optional vendor-config notes, or (b) vendor-only configuration such as
slash commands, MCP client wiring, or tool allow-lists. The file MUST NOT
contain unique project facts — if it does, move the content into
`AGENTS.md` or `docs/` and replace the vendor file with a pointer. As an
invariant, deleting every vendor-specific file from a clean checkout MUST
leave the project fully usable by any agent that reads `AGENTS.md`.

### Canonical guidance lives in committed repo files

Canonical agent guidance lives in committed repo files only — never in
private chat transcripts, task tracker comments, or vendor memory
features. If a fact only exists in a place an external contributor cannot
read after a fresh clone, it is not canonical.

## Commit & PR Style

- **Conventional commits** — `<type>(<area>): <subject>` (see Development
  Workflow above).
- **Atomic commits** — one logical change per commit; squash WIP commits
  before pushing.
- **Sign-off NOT required** — we do not enforce DCO sign-off. Just use a
  real name and email in your commits.
- **Link the issue** in the PR body: `Closes #123` or `Refs #123`.
- **Use the PR template** — fill in the summary, test plan, and any
  follow-ups it asks for.
- **Self-review first.** Read your own diff in the GitHub UI before
  requesting review.

## Release Process

Releases follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (`v2.0.0`) — breaking API, CLI, or MCP changes.
- **MINOR** (`v1.3.0`) — new features, backwards-compatible.
- **PATCH** (`v1.2.4`) — bug fixes, docs, internal refactors.

Maintainers cut releases by:

1. Updating `CHANGELOG.md` with the new version, date, and grouped notes
   (`Added`, `Changed`, `Fixed`, `Security`).
2. Bumping `version` in `package.json`.
3. Tagging the release: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push --tags`.
4. Publishing GitHub release notes from the changelog entry.

Only project maintainers (listed in the repo's GitHub team) can cut
releases. Contributors should not bump versions in their PRs — the
maintainer cutting the release will batch version bumps.

## Areas Welcoming Contribution

Looking for something to work on? These areas are explicitly open:

- **Bug fixes** — anything in the issue tracker labeled `bug`.
- **Doc improvements** — clarifications, examples, broken links, missing
  flags in `docs/CLI.md` or `docs/API.md`.
- **New MCP tools** — see `docs/MCP.md` for the tool authoring pattern.
  Good candidates: bulk operations, richer search, subtask helpers.
- **Additional CLI commands** — see `docs/CLI.md`. Composability with
  existing commands is preferred over one-off scripts.
- **Test coverage improvements** — raising the coverage floor or killing
  surviving mutants from the mutation report.
- **Performance work** — add a benchmark in a `*.bench.ts` file first,
  then optimize against it.

Questions? Open a discussion or a draft PR — we would rather talk early
than rewrite later.
