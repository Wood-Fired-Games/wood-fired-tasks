# Benchmark & Performance-Regression Policy

> Scope: how `wood-fired-tasks` benchmarks its known hot paths, what the
> recorded baselines are, and how performance regressions are surfaced in CI
> **without** blocking PRs. This is the authority for the bench suite; the
> [`CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md) cross-links here for the
> perf-regression follow-on.

## 1. Policy in one paragraph

Benchmarks are **advisory, not a per-PR hard gate.** They run nightly on a
schedule and on-demand (`workflow_dispatch`), plus opt-in per-PR via the
`bench` label. `npm run test:bench` only fails when **vitest itself errors**
(a broken bench file, an import failure, a thrown exception) — never on a perf
delta. Perf ceilings in the bench files are *soft*: crossing one is a signal to
investigate via the uploaded artifact, not a build break. Shared CI runners are
too noisy for a meaningful hard threshold, so we deliberately keep regression
detection in the human/trend loop rather than the merge gate.

## 2. Hot paths under benchmark

These were verified against the live source before listing. Each maps to a
`*.bench.ts` file.

| Hot path | Source of record | Bench file | Why it's hot |
|----------|------------------|------------|--------------|
| Task listing / filtering | `TaskRepository.findByFilters` (`src/repositories/task.repository.ts:450`) | `src/repositories/__tests__/task.repository.bench.ts` | Every list/board view; tag filter joins `task_tags` via `EXISTS`, no-filter page does `LIMIT/OFFSET` + `GROUP_CONCAT`. |
| Dependency-graph ops | `CycleDetector.wouldCreateCycle` (`src/utils/cycle-detector.ts`) | `src/utils/__tests__/cycle-detector.bench.ts` | Runs on every `add_dependency`; DFS depth scales with chain length and fan-out. |
| SSE fan-out | `SSEManager.broadcast` / `matchesFilters` (`src/events/sse-manager.ts:136`) | `src/events/__tests__/sse-manager.bench.ts` | Every task mutation fans out to all live SSE connections (default cap 200); per-connection filter check on the hot path. |

### Hot paths identified but **not yet** benchmarked

These are real hot paths verified in source. They have no dedicated bench yet;
adding one is tracked as a follow-on (see §6). They are listed here so the
coverage gap is explicit rather than silent.

| Hot path | Source of record | Status |
|----------|------------------|--------|
| Router dispatch / idempotency | `IdempotencyStore` + `evaluateWhere` predicate + `renderWith` template (`packages/wft-router/src/dispatch/`) | No bench. Idempotency is one SQLite row per `(rule_name, event_id)`; predicate/template run per matched event. Low per-event cost; benchmark only if dispatch volume grows. |
| Migrations | `runMigrations` (`src/db/migrate.ts`) — 15 migrations as of this writing | No bench. Run once at boot; each logged migration completes in single-digit ms locally. Not on a request hot path, so intentionally unbenched per the AC ("migrations, if applicable"). |

## 3. Stable invocation

```bash
npm run test:bench          # = vitest bench --run, all *.bench.ts
```

Scope to a single file when iterating:

```bash
npx vitest bench --run src/repositories/__tests__/task.repository.bench.ts
```

Discovery is governed by the `benchmark` block in `vitest.config.ts`
(`include: ['**/*.bench.ts']`, with `dist/`, `node_modules/`, and
`.claude/worktrees/**` excluded — see §5). The whole suite completes in well
under 60s locally; each `bench()` call uses a 2000ms `time` budget.

## 4. Recorded baseline expectations

Captured locally on Node v22 / vitest 4.1.8. Treat these as **order-of-magnitude
anchors**, not exact targets — `rme` (relative margin of error) is the noise
band. A regression worth investigating is roughly a **>2x mean slowdown** that
reproduces across nightly runs, not a single noisy sample. Soft ceiling in the
bench files is 250ms mean; all current benches sit far under it.

### `TaskRepository.findByFilters` (10k tasks, ~50k tags, `:memory:` DB)

| Bench | mean (ms) | hz (ops/s) | rme |
|-------|-----------|-----------|-----|
| no filter, default page | ~20.3 | ~49 | ±1.4% |
| `{ status: "open" }` | ~7.8 | ~129 | ±0.4% |
| `{ tags: ["bug","perf"] }` | ~20.6 | ~48 | ±1.1% |
| `{ project_id, status, tags }` (compound) | ~2.3 | ~433 | ±0.3% |

### `CycleDetector.wouldCreateCycle` (chain=1000, wide=10k edges)

| Bench | mean (ms) | hz (ops/s) | rme |
|-------|-----------|-----------|-----|
| closes long chain (cycle=true) | ~0.10 | ~9,900 | ±0.3% |
| extends chain (cycle=false) | ~0.13 | ~7,900 | ±0.3% |
| wide DAG, no cycle | ~0.30 | ~3,300 | ±0.2% |

### `SSEManager.broadcast` (200 mixed-filter connections)

| Bench | mean (ms) | hz (ops/s) | rme |
|-------|-----------|-----------|-----|
| task.created to all connections | ~0.026 | ~38,000 | ±0.3% |
| project_id filter mismatch (reject path) | ~0.025 | ~40,000 | ±0.3% |

Re-baseline by re-running §3 on a quiet machine when a hot path is intentionally
rewritten; update this table in the same PR. Do **not** re-baseline to hide an
unexplained regression — investigate first.

## 5. CI policy: advisory vs blocking

Defined in [`.github/workflows/bench.yml`](../.github/workflows/bench.yml):

- **Scheduled (advisory):** nightly cron `0 7 * * *` + `workflow_dispatch`.
  Always runs; uploads `bench-output.txt` as a 30-day artifact for trend
  inspection.
- **Per-PR (opt-in only):** runs on a PR **only** when the `bench` label is
  applied. Default PRs pay zero bench cost.
- **Never PR-blocking:** the job runs `npm run test:bench | tee bench-output.txt`.
  vitest bench exits non-zero only on an actual error, so the job fails only on
  a *broken* bench — never on a perf delta. There is intentionally **no hard
  performance threshold gate**, because shared GitHub runners are too noisy for
  a stable per-PR threshold and would flap.

If you want a perf snapshot on a specific PR, add the `bench` label and read the
artifact — do not add a failing assertion to a bench file.

## 6. Known benchmark issue fixed (#773) + follow-ons

**Fixed — bench mode ran every bench N+1 times.** `vitest bench` uses its own
`benchmark.include`/`benchmark.exclude` globs and does **not** inherit
`test.exclude`. The `.claude/worktrees/**` exclusion that keeps `npm test`
sane (task #717) was therefore *not* applied to bench mode, so `npm run
test:bench` re-discovered every `*.bench.ts` checked out under
`.claude/worktrees/agent-*/` (the isolation:"worktree" subagent checkouts).
Each benchmark ran once for the canonical tree **plus once per live sibling
worktree**, inflating runtime and polluting the comparison output with
duplicate suites. Fixed by adding an explicit `benchmark` block to
`vitest.config.ts` that mirrors the worktree/dist/node_modules excludes. After
the fix, `npm run test:bench` discovers only the three canonical bench files.

**Follow-ons (not blockers):**
- Add a router dispatch/idempotency bench if dispatch volume grows (§2).
- Consider a migrations bench only if boot-time migration cost becomes a
  concern; today it is single-digit ms and off the request path.
