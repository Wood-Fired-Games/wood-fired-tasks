# Code Quality Roadmap

Last reviewed: 2026-05-22

This guide records the current code quality baseline for `wood-fired-tasks`
and the phased work needed to move it toward a high-standard TypeScript
service posture. It is intentionally practical: keep the existing strengths,
close the highest-value gaps first, and avoid tooling churn that does not
reduce defects or maintenance cost.

## Current Baseline

The repository is already in a healthy state for a small TypeScript service:

- `tsconfig.json` enables `strict`, `forceConsistentCasingInFileNames`,
  declaration output, and Node16 module resolution.
- `npm run build` compiles the production TypeScript surface.
- `npm test` runs the Vitest suite; the latest baseline run reported 101 test
  files and 1300 tests.
- `vitest.config.ts` enforces coverage thresholds at 85% lines, functions,
  and statements, with 75% branches.
- `stryker.config.js` and `.github/workflows/mutation.yml` provide mutation
  testing with a 75% aggregate break threshold, sharded CI execution, and
  nightly/manual/label-triggered runs.
- Property and benchmark tests exist for high-risk areas such as workflow
  invariants, status transitions, and cycle detection.
- `knip.json`, `npm run lint:deps`, and the CI dependency job check unused
  dependencies.
- CI pins GitHub Actions by commit SHA and gates tests, coverage, dependency
  hygiene, and production dependency audit.
- `.github/workflows/secret-scan.yml` runs gitleaks and artifact hygiene, and
  `docs/RELEASE.md` documents release gates.
- The REST API uses Fastify with `fastify-type-provider-zod` and Zod schemas
  for request/response validation.
- SQLite access is centralized behind repositories and migrations, with WAL,
  foreign keys, busy timeout, Umzug migration tracking, and migration
  round-trip tests.
- `SECURITY.md` documents the supported security model and high-priority
  vulnerability classes.

The current quality floor is therefore much stronger than "tests compile and
pass." The roadmap below should preserve that floor while adding checks that
catch the kinds of defects TypeScript services commonly miss.

## Findings By Area

### TypeScript Strictness

Strengths:

- `strict: true` is enabled.
- Production code uses shared domain types for tasks, projects, comments,
  dependencies, and service contracts.
- Fastify route typing is strengthened by the Zod type provider.

Gaps:

- Several stricter compiler flags are not yet enabled, especially
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`,
  `useUnknownInCatchVariables`, and `noFallthroughCasesInSwitch`.
- Production paths still contain intentional but untracked casts around
  database rows, MCP structured output, Slack Block Kit objects, and a few
  event/filter boundaries.
- `Record<string, any>` appears in repository update/filter assembly, and
  an `as any` appears in dependency cycle error metadata.

Direction:

- Ratchet flags one at a time, with focused fixes and tests for behavioral
  changes.
- Add a visible exception pattern for remaining casts so unsafe boundaries are
  reviewed deliberately instead of drifting.

### Lint And Format Policy

Strengths:

- The codebase has a consistent local style.
- CI already enforces TypeScript compilation, tests, coverage, dependency
  hygiene, and audit checks.

Gaps:

- No ESLint, typescript-eslint, Biome, Prettier, or equivalent formatter
  configuration is present.
- No CI job currently catches unused variables, floating promises, missing
  awaits, unsafe assignment/member access, complexity, import cycles, or
  formatting drift.

Direction:

- Add a formatter first so mechanical style debates leave code review.
- Add lint in warning-free mode with a conservative initial rule set, then
  ratchet type-aware rules after the baseline is clean.

### Architecture Boundaries

Strengths:

- The code has clear entry-point layers: REST API, CLI, MCP, Slack,
  services, repositories, events, and shared schemas/types.
- Services and repositories are mostly separated, and DB access is not spread
  throughout route handlers.
- Existing tests cover integration paths, service invariants, and repository
  behavior.

Gaps:

- No import-boundary tool prevents future cross-layer coupling.
- No cycle detection or dependency graph check is part of CI.
- No complexity gate identifies functions that should be split or tested more
  deeply.

Direction:

- Start with import boundary checks for the most important rule:
  entry points may depend on services, services may depend on repositories,
  but lower layers must not depend on entry points.
- Add complexity reporting as advisory first, then gate only egregious cases.

### API And Schema Consistency

Strengths:

- REST routes use Zod schemas and Fastify response schemas.
- OpenAPI snapshot tests exist to detect endpoint and schema drift.
- CLI and MCP code use typed API client shapes.
- Idempotency headers and claim behavior have dedicated validation and tests.

Gaps:

- Some remote MCP tool handlers cast untyped tool arguments into API inputs.
- Some CLI/API compatibility helpers accept unknown response shapes and cast
  after shallow checks.
- Schema ownership spans route-specific schemas and shared service schemas;
  the pattern is documented in comments, but not enforced by tooling.

Direction:

- Keep Zod as the runtime boundary.
- Prefer parsing unknown external data through schemas before it crosses from
  CLI/MCP/Slack into services.
- Add tests where a schema is intentionally duplicated or mirrored.

### Database And Migration Safety

Strengths:

- Database initialization enables WAL, foreign keys, synchronous normal, and a
  busy timeout.
- Migrations are managed by Umzug and serialized with `BEGIN EXCLUSIVE`.
- Migration names are normalized between `.ts` and `.js` execution modes.
- Migration round-trip and migration-specific tests exist.
- Repositories use prepared statements for user-controlled values.

Gaps:

- Migration review expectations are spread across code/tests rather than
  captured as a short checklist.
- No automated migration linter checks for risky operations such as table
  rewrites, backfills, or irreversible down migrations.
- SQLite row casts are necessary with `better-sqlite3`, but they are not
  isolated behind typed row mappers everywhere.

Direction:

- Add a migration PR checklist section covering forward/backward behavior,
  transactionality, backfill safety, and rollback expectations.
- Introduce small row-mapping helpers where they remove repeated casts or
  protect nullable/date/tag conversion logic.

### Test Quality

Strengths:

- The suite is broad: API, CLI, services, repositories, Slack, MCP, events,
  migrations, snapshots, property tests, and benchmarks.
- Coverage thresholds are meaningful and already enforced.
- Mutation testing has a real break threshold.
- Concurrency and claim/release behavior have targeted tests.

Gaps:

- Mutation and benchmark runs are mostly scheduled or opt-in, which is
  reasonable, but makes local feedback slower for risky changes.
- Property tests are present but should remain focused on state transitions,
  dependency cycles, filtering, date windows, and idempotency invariants.
- No documented test selection policy tells contributors which test level is
  expected for route, service, repository, CLI, MCP, or Slack changes.

Direction:

- Document the expected test level by change type.
- Expand mutation/property/performance tests only where defect risk justifies
  the cost.

### Security Posture

Strengths:

- API key auth is documented clearly, including its all-admin nature.
- Auth, rate limit, request logging, redaction, and SSE caps have dedicated
  tests.
- Secret scanning and artifact hygiene run in CI.
- Production dependency audit fails on high/critical advisories.
- Release documentation includes security and artifact hygiene checks.

Gaps:

- No automated dependency update configuration was found.
- Security-relevant checklist items are split across `SECURITY.md`,
  `docs/RELEASE.md`, and PR template text.
- Typed validation at some MCP/Slack integration boundaries can be tightened.

Direction:

- Add Dependabot or Renovate for npm and GitHub Actions updates.
- Make the PR template ask explicitly whether auth, secrets, SQL/FTS, Slack,
  MCP, or migration behavior changed.

### Dependency Hygiene

Strengths:

- `npm audit --omit=dev --audit-level=high` is a CI gate.
- `knip --dependencies` catches unused dependency drift.
- GitHub Actions are pinned by commit.

Gaps:

- No dependency update automation is configured.
- No lockfile maintenance cadence is documented.
- Dev dependency advisories are not gated, which is often acceptable, but
  should be an explicit policy.

Direction:

- Configure automated dependency update PRs with grouped patch/minor updates.
- Keep production audit as a hard gate; decide whether dev audit is advisory
  or gated.

### CI And Release Gates

Strengths:

- CI runs tests, coverage, dependency hygiene, and production audit.
- Separate workflows cover mutation testing, benchmarks, install scripts,
  secret scanning, and package artifact hygiene.
- Release docs list manual pre-publish checks.

Gaps:

- CI does not run `npm run build` in the main workflow.
- CI has no lint/format gate.
- Release checks are documented but not fully encoded into `prepublishOnly` or
  a single local quality command.

Direction:

- Add a single `npm run quality` command once lint/format exists.
- Run build in CI so declaration output and compile-only regressions are
  caught on every PR.
- Consider `prepublishOnly` for the minimum release-safe subset:
  build, tests, dependency check, audit, and pack check.

### Observability

Strengths:

- Fastify request IDs are generated server-side and returned as
  `X-Request-ID`.
- Pino redaction protects sensitive headers.
- Auth labels can appear in request logging.
- Health endpoints and SSE manager health checks exist.

Gaps:

- No documented logging field policy exists for new routes and integrations.
- No structured error taxonomy guide maps service errors to API/CLI/MCP/Slack
  presentation consistently.

Direction:

- Document the required logging fields for request, auth, mutation, and
  background-event paths.
- Keep sensitive fields redacted by default.

### Maintainability

Strengths:

- The project is well decomposed for its size.
- Documentation exists for API, CLI, MCP, setup, Slack, release, security, and
  deployment.
- Planning and milestone notes provide useful context.

Gaps:

- This file is the first single quality roadmap.
- Some comments reference task numbers but there is no single review checklist
  for ongoing quality work.
- Complex integration boundaries rely on local knowledge.

Direction:

- Keep this roadmap updated as quality tasks land.
- Add a PR/release quality checklist and link it from the PR template and
  release guide.

## Prioritized Roadmap

### Phase 1: Establish Lint, Format, And Type Quality Floor

Goal: make baseline code quality mechanically enforceable.

Acceptance criteria:

- Choose ESLint plus Prettier, or Biome, based on lowest maintenance cost for
  this repo.
- Add `npm run lint`, `npm run format:check`, and `npm run format`.
- Add CI jobs for lint and format checks.
- Run the formatter once in a dedicated PR if needed.
- Keep the first lint rule set conservative and warning-free.

Recommended initial lint coverage:

- no unused variables/imports beyond what TypeScript already catches
- no floating promises
- no unhandled promises in async code
- no accidental `console` additions outside approved CLI/logging paths
- no `@ts-ignore`; require explained `@ts-expect-error` if unavoidable

### Phase 2: Tighten TypeScript Safety

Goal: ratchet compiler strictness without mixing too many behavior changes.

Acceptance criteria:

- Enable one compiler flag per PR, starting with low-friction flags.
- Add or update tests for any code whose behavior changes while satisfying the
  stricter flag.
- Document remaining intentional exceptions in this roadmap.

Suggested order:

1. `useUnknownInCatchVariables` — landed in task #265
2. `noFallthroughCasesInSwitch` — landed in task #265
3. `noImplicitOverride` — landed in task #265
4. `noPropertyAccessFromIndexSignature`
5. `exactOptionalPropertyTypes`
6. `noUncheckedIndexedAccess`

Deferred flags (still off, with rationale):

- `noPropertyAccessFromIndexSignature` — deferred; needs a sweep of
  `Record<string, any>` / dynamic access patterns; coupled with task #266.
- `exactOptionalPropertyTypes` — deferred; broad churn around
  optional-vs-undefined call sites and schema inference.
- `noUncheckedIndexedAccess` — deferred; introduces `T | undefined` at every
  index access; requires significant control-flow refactoring.

### Phase 3: Reduce Unsafe Casts And Untyped Boundaries

Goal: make unsafe code visible, isolated, and validated.

Acceptance criteria:

- Replace `Record<string, any>` with narrower parameter types where practical.
- Add row-mapping helpers for repository methods that repeatedly cast SQLite
  rows.
- Parse remote MCP and Slack command inputs through Zod before service/API
  calls where practical.
- Add an explicit lint exception pattern for unavoidable casts.

Priority targets:

- repository update/filter parameter construction
- MCP local and remote `structuredContent` casts
- Slack Block Kit casts
- SSE event filtering casts
- dependency cycle error metadata

### Phase 4: Add Architecture And Complexity Guardrails

Goal: prevent accidental layer erosion as the codebase grows.

Acceptance criteria:

- Add an import-boundary check for the main layers.
- Add an import-cycle check.
- Add complexity reporting for TypeScript files.
- Start complexity checks as advisory; only gate extreme outliers after the
  report has been reviewed.

Initial boundary policy:

- `src/api`, `src/cli`, `src/mcp`, and `src/slack` may depend on services,
  schemas, types, and utilities.
- `src/services` may depend on repositories, events, schemas, types, and
  utilities.
- `src/repositories` may depend on DB, types, and utility code.
- `src/db`, `src/types`, and `src/schemas` must not depend on entry-point
  layers.

Status:

- **Import-boundary + cycle checks: landed in task #267.** Enforced via
  [dependency-cruiser](https://github.com/sverweij/dependency-cruiser).
  Config at `.dependency-cruiser.cjs`, gate at `npm run depcruise`, CI
  job `depcruise` in `.github/workflows/ci.yml`. Contributor workflow
  is documented under "Architecture and Boundary Checks" in
  `CONTRIBUTING.md`.
- **Complexity reporting: ADVISORY report landed in task #771.** Implemented
  by reusing the existing Biome toolchain instead of adding a new dependency
  (`eslint-plugin-sonarjs` / `complexity-report` were the originally-suggested
  follow-ons but would have added an ESLint stack the repo does not otherwise
  run). See the **"Complexity Calibration"** section immediately below for the
  command, the calibrated outlier inventory, and the per-outlier
  refactor/test/accept disposition. **No blocking gate was added** — the
  calibration pass deliberately precedes any gate.

#### Complexity Calibration (task #771)

**Tooling.** Biome already ships `complexity/noExcessiveCognitiveComplexity`
(the SonarSource Cognitive Complexity algorithm), so the report reuses it with
**zero new dependencies**:

- Config: [`biome.complexity.json`](../biome.complexity.json) — a dedicated
  Biome config scoped to production TS only (`src/**/*.ts` and
  `packages/wft-router/src/**/*.ts`, with `**/*.test.ts`, `**/*.spec.ts`,
  `**/*.bench.ts`, `**/*.property.test.ts`, and `**/__tests__/**` excluded). It
  sets `maxAllowedComplexity: 1` so Biome emits a diagnostic carrying the raw
  score for **every** function (score ≥ 2); the script does the thresholding.
- Report script:
  [`scripts/quality/complexity-report.mjs`](../scripts/quality/complexity-report.mjs)
  runs Biome with the JSON reporter, parses the per-function scores, and prints
  a ranked outlier table + distribution histogram.
- Command: **`npm run quality:complexity`**
  (`--threshold N` changes the outlier cutoff, default 15 = Biome's own default
  ceiling; `--top N` row count; `--json` machine output).

**Advisory contract.** The report is advisory-only. `quality:complexity` exits
`0` regardless of how complex the code is, and exits non-zero (`2`) **only** if
Biome itself fails to execute. It is intentionally **not** part of the
`npm run quality` / `quality:fast` / `quality:full` gate chain. CI runs it in a
`complexity` job marked `continue-on-error: true` (report-only, not in the
required-checks set).

**Baseline (commit `ad0dc22`).** 551 functions score ≥ 2. Distribution:

| Cognitive complexity | Function count |
| -------------------- | -------------- |
| ≥ 21                 | 28             |
| 16–20                | 23             |
| 11–15                | 51             |
| 6–10                 | 133            |
| 2–5                  | 316            |

51 functions exceed Biome's default ceiling of 15. Top outliers and their
disposition (refactor / add-test / accept):

| Score | Location | Disposition |
| ----- | -------- | ----------- |
| 73 | `src/repositories/task.repository.ts:308` (claim transaction) | **accept (test-backed)** — one serialized CAS transaction; splitting it would fragment an intentionally-atomic claim. Already covered by claim/release concurrency + property tests. Revisit only if it grows. |
| 51 | `src/mcp/identity-resolution.ts:154` (`resolveActorUserIdWithPath`) | **refactor (candidate)** — multi-branch identity precedence resolver; extracting each resolution source into a named helper would cut the score and improve readability. Highest-value refactor target. |
| 45 | `src/mcp/remote/rest-client.ts:577` (SSE stream promise) | **accept** — streaming state machine with inherent branching; behavior is exercised by remote-client integration tests. |
| 42 | `src/api/routes/auth/callback.ts:53` (OAuth callback) | **refactor (candidate)** — OAuth error/branch handling; extract token-exchange and error-mapping steps. Security-sensitive, so refactor only with added route tests. |
| 41 | `packages/wft-router/src/sse/client.ts:368` (`runSSEClient`) | **accept** — async-generator reconnect loop; complexity is intrinsic to SSE reconnect/backoff. Covered by SSE client tests. |
| 40 | `packages/wft-router/src/dispatch/predicate.ts:72` (`evaluateWhere`) | **add-test** — predicate evaluator with many operators; before any refactor, ensure each operator branch has a unit test, then consider a per-operator dispatch table. |
| 38 | `src/cli/commands/doctor.ts:25` (doctor action) | **accept** — CLI diagnostic that linearly checks many conditions; low defect risk, output-only. |
| 36 | `src/services/wsjf-health.service.ts:168` (`analyzeWsjfHealth`) | **refactor (candidate)** — health-signal aggregation; extract per-signal analyzers. Has service tests; refactor is maintainability, not correctness. |
| 35 | `src/cli/commands/login.ts:51` (login action) | **accept** — interactive auth flow with many user-facing branches; CLI surface, low shared-logic risk. |
| 33 | `src/services/wsjf.service.ts:395` (`validateScoreSubmission`) | **add-test** — validation branch coverage matters; keep validation paths under property/unit tests, then optionally split per-field validators. |

The remaining 41 over-threshold functions (scores 16–32) are predominantly CLI
`.action()` handlers, Fastify route handlers, and WSJF service methods. The
general policy from this calibration:

- **CLI `.action()` handlers and Fastify route handlers** — *accept by default*.
  Their complexity is mostly linear option/branch handling at an I/O boundary
  with low shared-logic reuse and existing integration coverage; refactor only
  if a handler is actively churning.
- **Service methods with validation/aggregation logic** (`wsjf.service.ts`,
  `task.service.ts`, `topology.service.ts`, `evidence-validation.ts`) — *prefer
  add-test, then refactor*. These carry real domain logic, so test coverage of
  each branch is the priority; extraction into helpers is a follow-on.
- **Repository transactions** (`task.repository.ts`) — *accept*; atomic
  transactions should not be fragmented for a complexity number.

**No blanket rewrite was performed.** This section is calibration only; any
refactor above is a tracked follow-on, not part of task #771.

### Phase 5: Strengthen Database And Migration Safety

Goal: make migration risk review explicit.

Acceptance criteria:

- Add migration checklist language to the PR template.
- Document migration testing expectations in `docs/RELEASE.md` or this guide.
- Add targeted tests for every migration that changes data semantics, not only
  schema shape.
- Keep down migrations accurate, or explicitly document when a migration is
  forward-only.

Migration review checklist:

- Does the migration run inside the existing serialized migration flow?
- Is it safe for existing production data?
- Are defaults/backfills correct for null and legacy rows?
- Does it preserve foreign keys and indexes?
- Does the down migration actually restore the previous schema/data contract?
- Is there a backup/restore note for risky changes?

Status:

- **PR template + release-doc additions: landed in task #268.** The PR
  template gained a "Migration changes" section mirroring the checklist
  above; `docs/RELEASE.md` gained a "Migration expectations" section
  covering transactionality, backfills, forward-only policy, and operator
  backup/restore notes.
- **Migration audit (task #268):**

  | Migration                          | Kind                       | Targeted test                                |
  | ---------------------------------- | -------------------------- | -------------------------------------------- |
  | 001-initial-schema                 | schema-only                | round-trip snapshot only (sufficient)        |
  | 002-task-hierarchy-and-dependencies| schema-only                | round-trip snapshot only (sufficient)        |
  | 003-comments-and-estimates         | schema-only                | round-trip snapshot only (sufficient)        |
  | 004-claim-protocol                 | data-semantic (DEFAULT backfill of `version=1`, nullable `claimed_at`) | **added in #268** (`migration-004.test.ts`)  |
  | 005-backlogged-status              | data-semantic (table rebuild + copy) | present (`migration-005.test.ts`)           |
  | 006-slack-channel-subscriptions    | schema-only                | present (`migration-006.test.ts`)            |
  | 007-completed-at                   | data-semantic (`UPDATE` backfill) | present (`migration-007.test.ts`)           |

- **SQLite row mapping: largely covered by task #266.**
  `src/repositories/row-mapper.ts` funnels every nullable/date/tag-bearing
  read through `mapRow` / `mapRows`. The remaining ad-hoc casts in
  `src/repositories/*` are limited to `info.lastInsertRowid as number`,
  which is the better-sqlite3 return-type boundary rather than a row-shape
  cast. Any new repository method touching nullable/date/tag columns must
  use the helper; direct `stmt.get(...) as Row` should be reviewed as an
  exception (called out in `docs/RELEASE.md` migration expectations).

### Phase 6: Improve CI, Dependency, And Release Automation

Goal: make the documented release quality floor executable.

Acceptance criteria:

- Add `npm run build` to the main CI workflow.
- Add lint and format CI jobs after Phase 1.
- Add Dependabot or Renovate for npm and GitHub Actions updates.
- Add a single local `npm run quality` command once all fast checks exist.
- Consider `prepublishOnly` for release-critical checks.

Suggested `quality` scope once tooling exists:

- build
- tests
- lint
- format check
- dependency hygiene
- production audit
- pack check

Status:

- **Landed in task #269.** Four tightly-scoped CI/automation tweaks:
  1. `npm run build` added as the `build` CI job in
     `.github/workflows/ci.yml`.
  2. `format:check` is **intentionally omitted from CI and from
     `npm run quality`**; Biome's formatter is disabled in `biome.json`
     (`formatter.enabled=false`), so a real format gate requires a
     separate follow-on task that enables `formatter.enabled: true` and
     lands the one-time reformat sweep. The `format:check` script is
     kept in `package.json` but now exits non-zero with an explanatory
     message so it cannot silently pass as a false-positive gate.
     **Recommend that formatter-enable + reformat sweep as the next
     quality task.**
  3. `.github/dependabot.yml` configured for `npm` and `github-actions`
     ecosystems on a weekly Monday cadence, with patch/minor grouping to
     cut PR noise.
  4. `npm run quality` composite script chains build, test, lint,
     lint:deps, depcruise, and production audit (fail-fast `&&` order,
     cheapest gate first). `format:check` is deliberately excluded
     until the formatter is enabled.
  5. `prepublishOnly` script chains the minimum release-safe subset:
     build, test, lint:deps, production audit, and pack:check. Lint and
     format are intentionally omitted from `prepublishOnly` since they
     are quality signals, not release blockers.
- **Dev-dependency audit policy: advisory, not gated.** Codified in
  `CONTRIBUTING.md` under "Dependency audit policy". CI continues to gate
  production deps via `npm audit --omit=dev --audit-level=high`; dev-dep
  advisories are surfaced to contributors via local `npm audit` but do
  not block CI. Rationale: dev deps do not ship in the published
  package, and gating on dev-dep advisories produces frequent CI red
  without commensurate user-facing risk.

### Phase 7: Expand High-Value Mutation, Property, And Performance Coverage

Goal: spend expensive testing only where it is likely to find real defects.

Acceptance criteria:

- Identify modules with high bug impact and low mutation score.
- Add property tests for state machines, dependency cycles, date filters,
  idempotency, and pagination/filter combinations.
- Add benchmark coverage only for hot paths where performance regressions
  would affect real workflows.
- Keep nightly/label-triggered expensive checks unless a change is unusually
  risky.

Progress notes (task #270):

- Pagination/filter combinations were the gap among the roadmap's listed
  invariant areas — state-machine, claim/release CAS, and cycle-detection
  properties already existed under `src/**/__tests__/*.property.test.ts`,
  but no property test covered the page-walk / filter-narrowing invariants
  of the list endpoints.
- Landed
  [`src/services/__tests__/pagination-filter.property.test.ts`](../src/services/__tests__/pagination-filter.property.test.ts)
  asserting four invariants through the public `TaskService` surface
  (`listTasksPaginated`, `listTasks`, `countTasks`):
  1. Walking every page (`limit = L`, `offset = k*L`) reconstructs the
     un-paginated result with no duplicates and no drops.
  2. The envelope's `total` is invariant under page size and matches
     `countTasks(filters)`.
  3. Adding any filter is monotone — `count({A,B}) <= min(count{A}, count{B})`.
  4. Offsets at or past `total` return an empty `data` array while still
     reporting the correct `total`.
- Deferred to follow-on tasks (still in-scope for this phase but not landed
  in #270):
  - Mutation-result review for high-risk / low-score modules (`npm run
    test:mutation`). The existing 75% break threshold remains the active
    gate.
  - Date-filter property tests (`due_before`/`due_after`/`updated_*`
    boundary invariants) and idempotency-key TTL property tests, if the
    next mutation run flags those modules.
  - Additional benchmark files. Three benchmarks exist today
    (`sse-manager.bench.ts`, `cycle-detector.bench.ts`,
    `task.repository.bench.ts`) — only add more when a concrete hot path
    with regression risk is identified. The benchmark / performance-regression
    policy (hot paths, stable invocation, recorded baselines, advisory-vs-
    blocking CI rule) is documented in
    [`BENCHMARK_POLICY.md`](BENCHMARK_POLICY.md).

Progress notes (task #772) — mutation-result review:

- **Report source + date.** Survivors were extracted from the local Stryker
  HTML report at `reports/mutation/mutation.html` (dated **2026-02-17**;
  `reports/` is gitignored, so the artifact is read-only and not committed).
  The embedded data lives in the `app.report = {…}` object inside the page;
  note it is a JS expression, not strict JSON (it splits the literal
  `"k.length <"+"= 0"` to avoid emitting `</` in HTML), so it must be
  `vm`-evaluated rather than `JSON.parse`d. Run summary: 3970 mutants —
  1416 Killed, 526 Survived, 886 NoCoverage, 239 Timeout, 903 CompileError;
  overall score 46.2%, covered-only score 64.9%.
- **Staleness.** The report predates the `#732` driver-seam refactor and the
  `#761` Biome reformat sweep, so its line numbers are shifted relative to
  `HEAD`. The *behaviour* of the triaged code (the WorkflowEngine cascade-depth
  guard) is unchanged, so the survivor inventory is still valid; only treat the
  cited line numbers as approximate. Request a fresh run before relying on the
  numeric score again (see "When to request a mutation run" below).
- **Risk triage (Survived only — NoCoverage is a separate, lower-priority
  class).** Highest survivor counts cluster in CLI formatters / command files
  and `mcp/tools/task-tools.ts`; those are overwhelmingly `StringLiteral` /
  `ObjectLiteral` cosmetic mutants (low defect risk). The high-*risk* survivors
  are the logic mutants in the service/repository layer:
  - `src/services/workflow-engine.ts` (27 survivors) — the cascade-depth
    recursion guard. **Actioned (see below).**
  - `src/repositories/task.repository.ts` (26) — mostly dynamic-SQL
    `whereClauses`/`fields` length guards and `StringLiteral` glue; the
    `ConditionalExpression`/`EqualityOperator` survivors there are
    partial-update field-presence checks already exercised functionally.
    Documented-rationale: lower blast radius than the recursion guard; revisit
    if a fresh run still flags them.
  - Service/route `StringLiteral` survivors (`task.service.ts`,
    `project.service.ts`, `comment.service.ts`, `api/routes/events.ts`, …) are
    log/error-message and event-name literals — killing them asserts on exact
    strings, which is brittle and low-value. **Documented-rationale: not
    worth a test.**
- **Actioned survivors (WorkflowEngine cascade-depth guard).**
  - The `UpdateOperator` survivors on `this.cascadeDepth--` (one in
    `handleParentAutoComplete`, one in `handleDependencyAutoUnblock`) were the
    highest-value killable mutants: a dropped decrement leaks the recursion
    counter across *independent* top-level cascades, which would silently
    disable all parent-completion / auto-unblock automation after the first
    deep cascade. The existing depth-limit test ran only a single cascade and
    so tolerated a leaked counter.
  - Added two focused tests in
    [`src/services/__tests__/workflow-engine.test.ts`](../src/services/__tests__/workflow-engine.test.ts)
    under `describe('cascade depth decrement: …')`:
    1. Two independent deep parent chains back-to-back — the second root only
       completes if the counter reset to 0 (kills the parent-cascade
       `cascadeDepth--` mutant).
    2. An auto-unblock followed by a chain whose root sits at exactly
       `MAX_CASCADE_DEPTH = 5` — a leaked `+1` from the unblock pushes the root
       to depth 6 and trips the guard (kills the unblock `cascadeDepth--`
       mutant).
    Both were verified by hand-applying each mutant and confirming the matching
    test fails, then passes once reverted.
  - **Not chased (equivalent-mutant rationale):** the three
    `>= → >` (`EqualityOperator`) survivors on the depth guards
    (`processCascade`, `handleParentAutoComplete`,
    `handleDependencyAutoUnblock`) survive *individually* because the guard is
    deliberately redundant (defence-in-depth) — whichever check hits `>= 5`
    first stops the cascade, so flipping any single one to `>` leaves the
    observable boundary unchanged. Killing one in isolation would require
    deleting the other two guards, which we will not do. They are effectively
    equivalent mutants under the current redundant design and are documented
    here rather than tested.
- **Thresholds untouched.** `stryker.config.js` still enforces `break: 75`
  (high 80 / low 60); no threshold was lowered to absorb these survivors.

#### When to request a full mutation run

`npm run test:mutation` is expensive (10–30+ min) and is intentionally **not**
on the per-PR critical path — it runs nightly / on the `mutation` label (see
`.github/workflows/mutation.yml`). Contributors should request or trigger a
fresh run when:

- A change touches **recursion/cascade guards, transaction boundaries, state
  machines, or cycle detection** (WorkflowEngine, claim/release CAS,
  dependency cycle detector, SSE/event-bus transaction buffering) — i.e. logic
  where a survived `ConditionalExpression` / `EqualityOperator` /
  `UpdateOperator` mutant maps to a real correctness regression.
- A repository's **dynamic-SQL builder** (`whereClauses` / `fields` assembly)
  gains or loses a branch.
- The existing report is **stale relative to a structural refactor** (driver
  seam, large reformat, file moves) such that its line numbers no longer map —
  as is the case for the 2026-02-17 report above.

Do **not** request a run just to chase cosmetic `StringLiteral` / `ObjectLiteral`
survivors in CLI formatters or log messages; those are low defect risk and
mutation runs are a targeted, expensive signal, not a coverage-maximisation
gate.

### Phase 8: Adopt PR And Release Quality Checklist

Goal: make review expectations repeatable.

Acceptance criteria:

- Update `.github/PULL_REQUEST_TEMPLATE.md` with quality-specific checks.
- Link this roadmap from `docs/RELEASE.md`.
- Require reviewers to call out affected layers and test level.
- Require explicit migration/security notes when those surfaces are touched.

Suggested PR quality prompts:

- Which layers changed?
- Which runtime boundaries changed?
- What schema, migration, or data compatibility risk exists?
- Which tests prove the behavior?
- Did build, tests, lint/format, dependency check, audit, and pack check pass?

Status:

- **Landed in task #271.** `.github/PULL_REQUEST_TEMPLATE.md` gained a
  "Quality" section above the existing "Migration changes" section,
  covering affected layers, runtime boundaries, test level, the
  `npm run quality` composite gate, and security-sensitive surfaces.
  `docs/RELEASE.md` now cross-links this roadmap and the "Ongoing Review
  Checklist" section below as the canonical per-PR prompts, so the PR
  template stays scannable instead of duplicating the full roadmap.

## Ongoing Review Checklist

Use this checklist when reviewing non-trivial PRs:

- Types: no new broad `any`, unexplained casts, or suppressed errors.
- Runtime validation: external input is parsed at the boundary.
- Architecture: dependencies still point inward toward domain code.
- Database: migrations are reversible or explicitly forward-only, tested, and
  safe for existing data.
- API: route schemas, service contracts, CLI/MCP/Slack behavior, and OpenAPI
  snapshots stay consistent.
- Tests: the test level matches the risk, and assertions cover failure modes.
- Security: auth, secrets, logging, SQL/FTS, Slack signatures, MCP tools, and
  SSE behavior are considered when touched.
- CI/release: fast local gates are green; expensive gates are run or scheduled
  when risk justifies them.

## Definition Of Done For Quality Uplift

Status as of task #271 (Phase 8 close-out):

- **Lint gate: DONE.** Biome lint runs as the `lint` CI job and locally via
  `npm run lint` (0/0 baseline, warning-free). **Format gate: DEFERRED** —
  Biome formatter is intentionally disabled in `biome.json`; enabling it
  requires a one-time reformat sweep, called out as the recommended
  follow-on under Phase 6 status.
- **Stricter TypeScript flags: PARTIALLY DONE.**
  `useUnknownInCatchVariables`, `noFallthroughCasesInSwitch`, and
  `noImplicitOverride` landed in task #265. **DEFERRED:**
  `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`, and
  `noUncheckedIndexedAccess` — rationale captured under Phase 2 "Deferred
  flags".
- **Unsafe casts reduced, localized, or documented: DONE for the priority
  targets.** Repository row reads funnel through
  `src/repositories/row-mapper.ts` (task #266); remaining ad-hoc casts are
  limited to the `info.lastInsertRowid as number` boundary. Other priority
  targets (MCP structured output, Slack Block Kit, SSE event filtering,
  dependency-cycle metadata) are tracked under Phase 3.
- **Architecture / import boundaries checked automatically: DONE.**
  dependency-cruiser enforces layer rules and the no-cycles rule via
  `npm run depcruise` and the `depcruise` CI job (task #267). **Complexity
  reporting: DONE (advisory).** `npm run quality:complexity` reports
  cognitive-complexity outliers over production TS via the existing Biome
  toolchain (task #771); calibrated outlier inventory + dispositions are in
  the Phase 4 "Complexity Calibration" section. No blocking gate was added.
- **Build, tests, coverage, dependency hygiene, audit, lint, and format
  easy to run locally and visible in CI: MOSTLY DONE.** `npm run quality`
  chains build, test, lint, lint:deps, depcruise, and prod audit; CI runs
  the same gates. Format is the only deferred element (see Phase 6 status).
- **Dependency update automation: DONE.** `.github/dependabot.yml`
  configured for `npm` and `github-actions` on a weekly Monday cadence
  with patch/minor grouping (task #269).
- **Migration / security / test review expectations captured in PR and
  release workflows: DONE.** Migration checklist landed in the PR template
  and `docs/RELEASE.md` (task #268); per-migration test policy and the
  row-mapper convention codified under Phase 5. The PR template's
  "Quality" section and the `docs/RELEASE.md` cross-link to this roadmap
  (task #271) make the per-PR review prompts repeatable.

Remaining open items (tracked as follow-on tasks, not blockers for this
roadmap closeout):

- Formatter enable + one-time reformat sweep (Phase 6 follow-on).
- Complexity reporting calibration pass — **DONE (task #771)**; advisory
  `npm run quality:complexity` + Phase 4 "Complexity Calibration" section.
  Any per-outlier refactor remains a tracked follow-on.
- Remaining strict-TS flag ratchet for `noPropertyAccessFromIndexSignature`,
  `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` (Phase 2
  deferred list).
- Mutation review for high-risk / low-score modules and additional date-
  filter / idempotency-TTL property tests (Phase 7 follow-on).
