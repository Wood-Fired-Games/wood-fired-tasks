# TypeScript Quality Excellence Audit 2026

> **Project:** [Wood Fired Tasks — project 37, "TypeScript Quality Excellence Audit 2026"](#7-links-to-the-task-project)
> **Decomposition id:** `e74fbce9-6e77-4f13-a50a-51257a079d2f`
> **Phase-0 root task:** #760 (this document is its deliverable)
> **Audit date:** 2026-06-05
> **Base commit:** `a872170` (`feat/frictionless-distribution`)

This is a **baseline quality audit** of the `wood-fired-tasks` TypeScript
service. It evaluates the **current repo state** against high-standard
TypeScript service expectations, using **concrete evidence** pulled from the
actual config and source tree (see [§5 Commands Used](#5-commands-used-reproducibility)
for the reproducible command set). It is the evidence anchor every later
project-37 task builds on.

It deliberately does **not** remediate code. Where it recommends work, it
points at the existing [`docs/CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md)
and reconciles against it (see [§4](#4-prioritized-roadmap-reconciled)) so we
do not duplicate stale roadmap text.

**Value-charter framing.** Project 37's value themes and weights are:
Defect prevention (13), Boundary integrity (8), Contributor velocity (5),
Release confidence (3), Maintainability (2). The scorecard and roadmap below
are ordered to spend effort where it moves those weighted themes most — i.e.
defect-prevention and boundary-integrity gaps rank above maintainability
polish.

---

## 1. Current-State Evidence

All values below were read directly from the repo at commit `a872170`. File
references are clickable; raw counts come from the scans in [§5](#5-commands-used-reproducibility).

### 1.1 Compiler strictness — [`tsconfig.json`](../tsconfig.json)

| Flag | State | Notes |
| --- | --- | --- |
| `strict` | **ON** | umbrella flag (noImplicitAny, strictNullChecks, etc.) |
| `useUnknownInCatchVariables` | **ON** | explicit (landed task #265) |
| `noFallthroughCasesInSwitch` | **ON** | explicit (landed task #265) |
| `noImplicitOverride` | **ON** | explicit (landed task #265) |
| `forceConsistentCasingInFileNames` | **ON** | |
| `noPropertyAccessFromIndexSignature` | **ON** | explicit (ratcheted task #763) |
| `exactOptionalPropertyTypes` | **OFF** | not set → defaults off |
| `noUncheckedIndexedAccess` | **OFF** | not set → defaults off |

Other compiler settings: `target: ES2022`, `module/moduleResolution: Node16`,
`declaration: true`, `sourceMap: true`, `skipLibCheck: true`,
`resolveJsonModule: true`. `rootDir: ./src`, `outDir: ./dist`. Tests/benches
are excluded from the production compile (`**/*.test.ts`, `**/*.bench.ts`,
`**/__tests__/**`). TypeScript dep is `typescript@^6.0.3`; Node engine is
`>=22`.

**The three "deferred" strict flags are the single largest remaining
strictness gap.** `noUncheckedIndexedAccess` in particular is the highest-value
defect-prevention flag still off (it forces `T | undefined` at every index /
array access).

> **Ratchet status — `noPropertyAccessFromIndexSignature` landed (task #763).**
> Enabled in the root `tsconfig.json` (propagates to `packages/wft-router` via
> `extends`). The flag surfaced **210 TS4111 sites** (188 root + 22 router), all
> of which were *genuine* index-signature / `Record` / external-payload-bag
> accesses — `process.env[...]`, Commander-parsed option bags (`['json']`,
> `['token']`), raw SQLite row/param bags in the repositories, and external JSON
> payloads (OIDC claims, MCP tool args, callback userinfo). Every site was a pure
> `obj.foo` → `obj['foo']` syntactic conversion (no declared object property was
> bracketed, no runtime behavior changed, no new test required). **Zero escape
> hatches were needed** — there are no `noPropertyAccessFromIndexSignature`
> exceptions recorded against the §3 budget for this flag.

### 1.2 Formatting — [`biome.json`](../biome.json)

- `formatter.enabled` = **`false`**. This is intentional and load-bearing: the
  `package.json` `format:check` script is hard-wired to `exit 1` with an
  explanatory message ("format:check is unavailable: biome.json has
  formatter.enabled=false…"). There is **no format gate in CI or in
  `npm run quality`**.
- A full formatter *config* exists (indentWidth 2, lineWidth 100, single
  quotes, semicolons always, trailing commas all) but is dormant until
  `formatter.enabled: true` plus a one-time reformat sweep lands.
- **Evidence finding (new):** `biome.json`'s `$schema` pins **2.4.15** while
  the installed `@biomejs/biome` is **2.4.16**. `npm run lint` emits exactly
  one **info**-level diagnostic about this (`Expected: 2.4.16 / Found:
  2.4.15`). Lint is otherwise clean.

### 1.3 Lint — [`biome.json`](../biome.json) + `package.json` `lint`

- `linter.enabled` = **`true`**, but `rules.recommended` = **`false`** — the
  repo runs a **deliberately minimal** rule set, not Biome's recommended
  preset. Only two rules are on:
  - `suspicious/noConsole` = **error** (allow `error`/`warn`; CLI/MCP/scripts
    override also allows `log`/`info`; tests turn it off).
  - `suspicious/noTsIgnore` = **error** (bans `@ts-ignore` in non-test code).
- `assist.enabled` = `false`.
- `npm run lint` = `biome check .`. Current state: **clean** — `Checked 575
  files`, 0 errors/warnings, 1 info (the schema-version mismatch above).
- **Gap:** the high-value type-aware lint rules the old roadmap's Phase 1
  envisioned — no-floating-promises, no-unhandled-promise, unsafe
  assignment/member access — are **not** present. Biome does not do
  type-aware lint, and no typescript-eslint layer exists. Async-safety is
  therefore **unguarded by lint**.

### 1.4 Testing / coverage — [`vitest.config.ts`](../vitest.config.ts)

- Runner: Vitest 4 (`@vitest/coverage-v8@^4`). `fileParallelism: false`
  (sequential to avoid env-var conflicts). Worktree checkouts under
  `.claude/worktrees/**` are excluded from discovery.
- **Coverage thresholds (hard gate via `test:coverage` CI job):**
  `lines 85`, `functions 85`, `statements 85`, `branches 75`. Provider v8.
  Coverage `include` is `src/**/*.ts`; entry points / `types` / `schemas` /
  migrations / `bin` are excluded from the denominator.
- Suite size at this commit: **247 `*.test.ts` files**, **~2,931 `it()`/
  `test()` cases** (static count; the suite was not executed for this audit).
  The 4 `*.property.test.ts` and 3 `*.bench.ts` files live in `src/`.

### 1.5 Mutation testing — [`stryker.config.js`](../stryker.config.js) + `.github/workflows/mutation.yml`

- Stryker 9.5 with the **vitest runner** and the **typescript checker**
  (`checkers: ['typescript']`, `prioritizePerformanceOverAccuracy: true`).
- Thresholds: `high 80`, `low 60`, **`break 75`** (local). CI runs are
  **sharded** via `STRYKER_MUTATE_GLOBS`; per-shard `break` is disabled
  (`STRYKER_DISABLE_BREAK_THRESHOLD=1`) and the unified 75% break is enforced
  by `scripts/aggregate-mutation-reports.ts` against the merged JSON.
- `mutation.yml` triggers: **nightly cron** (`0 6 * * *`),
  `workflow_dispatch`, and label/PR events — i.e. expensive mutation is
  scheduled/opt-in, not on every PR.

### 1.6 Dependency boundaries — [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs)

Five `error`-severity forbidden rules enforce a layered architecture
(`api/cli/mcp/slack` → `services` → `events` → `repositories` → `db`; with
`schemas/types/utils/config` as leaves any layer may use):

1. `no-circular` — no import cycles within `src/`.
2. `leaves-no-upstream` — `db/types/schemas` may not import entry-point or
   business-logic layers.
3. `repositories-layer` — repositories may import only db/types/schemas/utils/
   config/other-repositories.
4. `events-layer` — events may import only schemas/types/utils/config.
5. `services-layer` — services must not import entry-point layers.

Run via `npm run depcruise` (cruises `src` **and** `packages/wft-router/src`);
CI job `depcruise`. dependency-cruiser 17.4.3.

### 1.7 Runtime boundary validation (Zod) — source scan

- `zod@^4.3.6` + `fastify-type-provider-zod@^6.1.0` on `fastify@^5.8.5`.
- **42** source files import `zod`. `.safeParse(` appears **19×** in non-test
  src, `.parse(` **230×** across the tree. Routes use Zod request/response
  schemas via the Fastify type provider; OpenAPI snapshot tests guard drift
  (per existing roadmap §"API And Schema Consistency").
- **`structuredContent`** (the MCP tool-output boundary) appears **250×**
  total, **62×** in non-test src — a recognized cast-heavy boundary (see
  §1.8).

### 1.8 Unsafe-pattern census — source scan

Counts split test vs. non-test (test casts are largely fixture scaffolding and
lower-risk):

| Pattern | Non-test src | Test | Total |
| --- | --- | --- | --- |
| `as any` | **10** | 57 | 67 |
| `as unknown` | **75** | 164 | 239 |
| `@ts-expect-error` / `@ts-ignore` | **0** | 7 | 7 |
| `biome-ignore` | 0 | 0 | 0 |
| bare `: any` annotation | 2 | — | 2 |
| `TODO` / `FIXME` | 0 | 0 | 0 |

Interpretation:
- **Zero `@ts-ignore`/`@ts-expect-error` in production code** — consistent
  with the `noTsIgnore` lint rule; all 7 live in 3 test files
  (`identity-types`, `fastify-augmentation`, `auth-audit`), which is the
  expected place for deliberate type-violation tests.
- The residual production unsafety is **10 `as any` + 75 `as unknown` + 2
  bare `: any`**. These cluster at the documented boundaries: SQLite rows,
  MCP `structuredContent`, Slack Block Kit, SSE event filtering, dependency-
  cycle metadata. Most SQLite row casts are already funnelled through
  [`src/repositories/row-mapper.ts`](../src/repositories/row-mapper.ts) (task
  #266); the `as any` residue is the next-most-visible target.

### 1.9 CI / release gates — [`.github/workflows/`](../.github/workflows/)

Workflows: `ci.yml`, `mutation.yml`, `bench.yml`, `install-scripts.yml`,
`publish.yml`, `secret-scan.yml`.

**`ci.yml`** (on push/PR to `main`; `permissions: contents: read`;
concurrency-cancel; all actions SHA-pinned; Node 22). Jobs:

| Job | Gate |
| --- | --- |
| `test` | `npm test` |
| `coverage` | `npm run test:coverage` (fails if thresholds drop) |
| `deps` | `npx knip --dependencies` (unused-dep drift) |
| `depcruise` | import boundaries + cycles |
| `lint` | `npm run lint` (biome) |
| `build` | `npm run build` (tsc, incl. wft-router + skills) |
| `audit` | `npm audit --omit=dev --audit-level=high` |
| `agent-context` | manifest/link/budget check |
| `vendor-neutrality` | forbid vendor names in router core |
| `pack-smoke` | builds + validates router tarball contents |
| `oci-build` | multi-arch router image build (no push) |
| `host-manifests` | systemd/launchd/windows manifest lint |

- **`secret-scan.yml`** runs **gitleaks** full-history (PR/push/weekly cron)
  + artifact hygiene.
- **`format:check` is NOT a CI gate** (formatter disabled — §1.2).
- Composite local gate: `npm run quality` = build && test && lint &&
  lint:deps && depcruise && prod audit. `prepublishOnly` = build && test &&
  lint:deps && audit && pack:check.
- Dependency automation: [`.github/dependabot.yml`](../.github/dependabot.yml)
  — npm + github-actions, weekly Monday, patch/minor grouped.

### 1.10 PR template — [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md)

Has Summary / Related issue / Type / Checklist (tests, coverage, docs, style,
atomic commits) / **Risk assessment** / **Quality** (affected layers, runtime
boundaries, test-level matrix, `npm run quality`, security-sensitive surfaces)
/ **Migration changes** (7-item checklist) / Screenshots. Cross-links
`docs/CODE_QUALITY_ROADMAP.md`.

### 1.11 Docs surface — [`docs/`](.)

37+ docs including `CODE_QUALITY_ROADMAP.md`, `ARCHITECTURE.md`, `API.md`,
`MCP.md`, `RELIABILITY.md`, `RELEASE.md`, `AGENT_CONTEXT.md`,
`AGENT_READINESS_AUDIT.md`, plus `CONTRIBUTING.md` and `SECURITY.md` at root.
The agent-context manifest is CI-verified (`agent-context:check`).

---

## 2. Comparison to Modern TS Service Practices

How the repo measures against high-standard TypeScript service norms (2026):

| Norm | Modern expectation | This repo | Verdict |
| --- | --- | --- | --- |
| `strict` on | table stakes | ON, plus 3 extra strict flags | **Meets** |
| Full strict surface | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` on | all 3 OFF | **Below** |
| Runtime boundary validation | parse external input with Zod/valibot at the edge | Zod on routes + 42 files; MCP/Slack edges still cast | **Mostly meets** |
| Async safety | lint bans floating/unhandled promises | no type-aware lint; unguarded | **Below** |
| Formatter | enforced (Prettier/Biome) | configured but **disabled**; no gate | **Below** |
| Lint baseline | recommended preset + ratcheted type-aware rules | `recommended:false`, 2 rules | **Below** (minimal by choice) |
| Coverage gate | enforced threshold | 85/85/85/75 enforced in CI | **Meets** |
| Mutation testing | rare even at high bar; bonus | Stryker, 75% break, sharded, nightly | **Exceeds** |
| Dependency boundaries | enforced layering / cycle ban | dependency-cruiser, 5 rules, CI gate | **Exceeds** |
| Supply chain | pinned actions, prod audit, secret scan, dep-bot | all present (SHA-pin + gitleaks + dependabot) | **Exceeds** |
| Build-in-CI | tsc on every PR | `build` job present | **Meets** |
| Property-based testing | bonus | 4 property tests on invariants | **Exceeds** |
| PR/review contract | template enforces test-level + risk | rich template | **Meets** |

**Net:** the repo sits **well above the median TS service** on testing,
mutation, boundary enforcement, and supply-chain — and **below the high bar**
on the last-mile compiler-strictness flags, async-safety lint, and formatting.
The gaps are concentrated and well understood, not systemic.

---

## 3. Scorecard By Area

Scale: **0–5**, where 5 = at or above the high-standard TS-service norm,
3 = solid/acceptable with a known gap, ≤2 = a real gap worth prioritizing.
"Charter weight" maps the area to project-37's value themes.

| # | Area | Score | Charter theme (weight) | Evidence basis |
| --- | --- | :---: | --- | --- |
| 1 | Compiler strictness | **3.5** | Defect prevention (13) | strict + 3 flags on; 3 high-value flags off (§1.1) |
| 2 | Formatting | **1.5** | Contributor velocity (5) | `formatter.enabled:false`, no gate, schema drift (§1.2) |
| 3 | Lint | **2.5** | Defect prevention (13) | clean but `recommended:false`, 2 rules, no type-aware (§1.3) |
| 4 | Async safety | **2** | Defect prevention (13) | no floating/unhandled-promise lint (§1.3) |
| 5 | Runtime boundary validation | **3.5** | Boundary integrity (8) | Zod on routes; MCP/Slack/SSE casts remain (§1.7–1.8) |
| 6 | Testing / coverage | **4.5** | Release confidence (3) | 85/85/85/75 enforced, ~2,931 cases (§1.4) |
| 7 | Mutation testing | **4.5** | Defect prevention (13) | Stryker 75% break, sharded, nightly (§1.5) |
| 8 | Dependency boundaries | **5** | Boundary integrity (8) | 5 dep-cruiser rules + cycle ban, CI gate (§1.6) |
| 9 | CI / release | **4.5** | Release confidence (3) | 12 CI jobs, SHA-pinned, audit, secret-scan, dependabot (§1.9) |
| 10 | Docs | **4** | Maintainability (2) | broad docs, CI-verified manifest; this audit + roadmap (§1.11) |

**Weighted reading.** The lowest scores (Formatting 1.5, Async safety 2,
Lint 2.5) split across two charter themes. Async safety and Lint feed
**Defect prevention (weight 13)** — the project's top theme — so they
out-prioritize Formatting (Contributor velocity, weight 5) despite Formatting
scoring lowest. Compiler-strictness uplift (area 1) and the MCP/Slack
boundary-cast reduction (area 5) are the other high-charter-weight moves.

---

## 4. Prioritized Roadmap (Reconciled)

This section **reconciles against** [`docs/CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md)
(last reviewed 2026-05-22) rather than restating it. Ordering follows the
charter weights, not the old roadmap's phase numbers.

### 4.1 Reconciliation — what the old roadmap got right vs. what is now stale

**Current / still accurate:**

- Phase 4 (boundaries) — **DONE and accurate.** dependency-cruiser is live
  with exactly the rules the roadmap described (§1.6 confirms).
- Phase 5 (migration safety) — **accurate.** PR template + `row-mapper.ts`
  exist as described.
- Phase 6 status — **accurate.** `npm run quality`, `prepublishOnly`,
  dependabot, and the deliberate `format:check` exit-1 all match the repo.
- Phase 8 (PR quality section) — **accurate**; the template matches §1.10.
- Phase 2 "landed" items — `useUnknownInCatchVariables`,
  `noFallthroughCasesInSwitch`, `noImplicitOverride` — **all confirmed ON**
  (§1.1).

**Stale / drifted relative to the present repo:**

- **The old roadmap's Phase 1 "Lint And Format Policy" Gaps are out of
  date.** It says *"No ESLint, typescript-eslint, Biome, Prettier… is
  present"* and *"No CI job currently catches… formatting drift."* Biome
  **is** present and the `lint` CI job exists. The accurate residual gap is
  narrower: **formatter disabled** + **`recommended:false` minimal rule set**
  + **no type-aware/async-safety rules** — not "no tooling at all."
- The Phase 1 CI claim *"CI does not run `npm run build`"* (echoed in Phase 6
  Gaps) is **stale** — the `build` job exists in `ci.yml` (§1.9).
- The "Current Baseline" line *"101 test files and 1300 tests"* is **stale** —
  the suite is now **247 test files / ~2,931 cases** (§1.4). The coverage
  threshold prose (85/75) is still accurate.
- The biome schema-version mismatch (§1.2) is a **new** finding not in the old
  roadmap.

The old roadmap remains the authoritative *narrative*; this audit is the
**point-in-time numeric ground truth** as of `a872170`. The items below are
the open work, deduplicated against the old roadmap's "Remaining open items".

### 4.2 Prioritized improvements (charter-weighted)

| Rank | Improvement | Charter theme | Maps to old roadmap | Why this rank |
| :---: | --- | --- | --- | --- |
| **P1** | Add async-safety lint (no-floating-promises / no-unhandled-promise). Needs a typescript-eslint layer or equivalent, since Biome is not type-aware. | Defect prevention (13) | new — not in old Phase 1 list as a standalone gap | Highest-weight theme; currently **unguarded**; catches a defect class tests routinely miss. |
| **P2** | Ratchet `noUncheckedIndexedAccess`, then `exactOptionalPropertyTypes`, then `noPropertyAccessFromIndexSignature` — one flag per PR with focused fixes. | Defect prevention (13) | Phase 2 deferred list (accurate) | Largest remaining strictness gap; highest defect-prevention payoff per flag. |
| **P3** | Reduce the 10 production `as any` + tighten MCP `structuredContent` / Slack / SSE casts via Zod-at-boundary. | Boundary integrity (8) | Phase 3 (accurate, partial) | Directly hardens the runtime boundary (area 5); high charter weight. |
| **P4** | Resolve biome schema drift (2.4.15→2.4.16) and decide the lint posture: stay minimal-by-design or adopt a curated rule subset above `recommended:false`. | Defect prevention (13) / velocity (5) | extends Phase 1 | Cheap; removes the one standing info diagnostic and clarifies intent. |
| **P5** | Enable `formatter.enabled:true` + one-time reformat sweep, then re-add `format:check` to CI and `npm run quality`. | Contributor velocity (5) | Phase 6 follow-on (accurate) | Removes review noise; lower charter weight, hence below the defect-prevention items. |
| **P6** | Mutation review of high-risk / low-score modules; add date-filter + idempotency-TTL property tests. | Defect prevention (13) / release confidence (3) | Phase 7 follow-on (accurate) | Expensive; spend only where the next mutation run flags real survivors. |
| **P7** | Complexity reporting (advisory `eslint-plugin-sonarjs` / `complexity-report`), gate only egregious outliers. | Maintainability (2) | Phase 4 deferred (accurate) | Lowest charter weight; advisory-first. |
| **P8** | Refresh `docs/CODE_QUALITY_ROADMAP.md` stale facts (test counts, "no build in CI", "no Biome") against this audit. | Maintainability (2) | this reconciliation | Keeps the narrative roadmap honest; cheap doc-only. |

---

## 5. Commands Used (Reproducibility)

Exact shell commands run from the repo root at `a872170` to gather the
evidence above:

```bash
# Base check
git rev-parse HEAD

# Config inventory
ls tsconfig*.json biome.json vitest.config.* stryker.conf.* .stryker.conf.* .dependency-cruiser.cjs
ls .github/workflows/
ls docs/
ls .github/PULL_REQUEST_TEMPLATE.md
find . -name "stryker*" -not -path "*/node_modules/*"

# package.json scripts + relevant dep versions
node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,1))"
node -e "const p=require('./package.json'); console.log(Object.keys(p.devDependencies).filter(k=>/stryker|vitest|biome|dependency-cruiser|typescript|zod/i.test(k)).map(k=>k+'@'+p.devDependencies[k]).join('\n'))"
node -e "const p=require('./package.json');const d={...p.dependencies,...p.devDependencies};['fastify-type-provider-zod','zod','fastify','better-sqlite3','pino'].forEach(k=>console.log(k,d[k]))"
node -e "console.log(JSON.stringify(require('./package.json').engines))"

# Config bodies read via the editor: tsconfig.json, biome.json,
# vitest.config.ts, stryker.config.js, .dependency-cruiser.cjs,
# .github/workflows/ci.yml, .github/PULL_REQUEST_TEMPLATE.md,
# docs/CODE_QUALITY_ROADMAP.md, .github/dependabot.yml, knip.json

# Unsafe-pattern census (non-test vs test split)
grep -rn "as any" src --include=*.ts | wc -l
grep -rn "as any" src --include=*.ts | grep -vE "\.test\.ts|__tests__" | wc -l
grep -rn "as unknown" src --include=*.ts | grep -vE "\.test\.ts|__tests__" | wc -l
grep -rn "@ts-expect-error\|@ts-ignore" src --include=*.ts | wc -l
grep -rln "@ts-expect-error\|@ts-ignore" src --include=*.ts
grep -rn ": any\b" src --include=*.ts | grep -v ".test.ts" | wc -l
grep -rn "TODO\|FIXME" src --include=*.ts | wc -l
grep -rn "biome-ignore" src --include=*.ts | wc -l

# Boundary-validation surface
grep -rln "from 'zod'\|from \"zod\"" src --include=*.ts | wc -l
grep -rn "\.safeParse(" src --include=*.ts | grep -vE "\.test\.ts|__tests__" | wc -l
grep -rn "structuredContent" src --include=*.ts | grep -vE "\.test\.ts|__tests__" | wc -l

# Test surface (static counts; suite NOT executed)
find src -name "*.test.ts" | wc -l
grep -rhoE "\b(it|test)\(" src --include=*.test.ts | wc -l
find src -name "*.property.test.ts" | wc -l
find src -name "*.bench.ts" | wc -l

# Confirm deferred strict flags are absent (off)
grep -E "exactOptionalPropertyTypes|noUncheckedIndexedAccess|noPropertyAccessFromIndexSignature" tsconfig.json

# Live lint state (cheap)
npm run lint 2>&1 | tail -15
```

---

## 6. Known Limits Of This Audit

What was **not** verified, and why:

1. **The test suite was not executed.** Test counts (247 files / ~2,931
   cases) are **static** `grep`/`find` counts, not a Vitest run. The
   `coverage` job's *actual* current percentages were **not** measured — only
   the **configured thresholds** (85/85/85/75) were read. Running
   `npm test` / `npm run test:coverage` is out of scope for a docs task and
   expensive. The old roadmap's "around 88/87/77/87" figures are unverified
   here.
2. **No mutation run.** The 75% break threshold and trigger config were read
   from `stryker.config.js` / `mutation.yml`; the **current mutation score
   was not computed** (a full `stryker run` is very expensive).
3. **No build run.** `npm run build` / `tsc` was not executed; the strict-flag
   states are read from `tsconfig.json`, not validated by compiling under each
   candidate flag. Estimating the blast radius of enabling
   `noUncheckedIndexedAccess` etc. requires an actual compile and is left to
   the per-flag ratchet tasks.
4. **No `depcruise` / `knip` / `audit` execution.** Boundary rules, unused-dep
   config, and audit gate were read from config; the gates were not run for
   live pass/fail. `npm run lint` **was** run (cheap) and is the one live gate
   result reported.
5. **Cast census is keyword-grep, not AST.** `as any` / `as unknown` counts
   are line-grep totals; they do not distinguish a genuinely-unsafe cast from
   a benign one (e.g. `as unknown as T` double-casts count once per line).
   They are a **directional** signal, not a precise unsafe-cast inventory.
6. **`packages/wft-router/src` is mostly excluded from the src scans.** The
   `src/`-rooted greps cover the main service; the bundled router package's
   source was only spot-checked (it is in the depcruise/knip/build scope but
   not in the per-pattern counts above).
7. **Charter weights are taken as given** (Defect prevention 13, Boundary
   integrity 8, Contributor velocity 5, Release confidence 3, Maintainability
   2) from the task brief; they were not independently re-derived from the
   project's WSJF charter record.

---

## 7. Links To The Task Project

- **Project 37 — "TypeScript Quality Excellence Audit 2026."** This document
  is the deliverable for its **phase-0 root task #760**.
- **Decomposition id:** `e74fbce9-6e77-4f13-a50a-51257a079d2f`.
- **Value charter (themes / weights):** Defect prevention (13), Boundary
  integrity (8), Contributor velocity (5), Release confidence (3),
  Maintainability (2) — used to order [§3](#3-scorecard-by-area) and
  [§4](#4-prioritized-roadmap-reconciled).
- **Anchoring guidance for later project-37 tasks.** Each prioritized item in
  §4.2 is a natural child-task seam; map child tasks to areas as follows:
  - Async-safety lint → **P1** (area 4, Defect prevention).
  - Strict-flag ratchet (`noUncheckedIndexedAccess` →
    `exactOptionalPropertyTypes` → `noPropertyAccessFromIndexSignature`) →
    **P2** (area 1, Defect prevention). One flag per child task.
  - Production `as any` / MCP-Slack-SSE boundary casts → **P3** (area 5,
    Boundary integrity).
  - Biome schema drift + lint-posture decision → **P4** (area 3).
  - Formatter enable + reformat sweep → **P5** (area 2, Contributor velocity).
  - Mutation review + property tests → **P6** (areas 6/7).
  - Complexity reporting → **P7** (area 1/Maintainability).
  - Refresh stale `CODE_QUALITY_ROADMAP.md` facts → **P8** (area 10).
- **Companion docs:** [`docs/CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md)
  (narrative roadmap, reconciled in §4.1) and
  [`docs/AGENT_READINESS_AUDIT.md`](AGENT_READINESS_AUDIT.md) (sibling
  point-in-time audit format).

---

## Unsafe TypeScript Escape-Hatch Policy & Production Budget

> **Project 37, phase-3 — task #766.** This section turns the §1.8 unsafe-pattern
> census into an **enforced policy**: a documented inventory, rules for when an
> escape hatch is allowed in production, the required inline rationale, and a
> CI-gated **budget** (ratchet) that fails the build when a *new, unexplained*
> production escape hatch is added. It is implemented by
> [`scripts/quality/escape-hatch-budget.mjs`](../scripts/quality/escape-hatch-budget.mjs)
> reading the committed baseline
> [`scripts/quality/escape-hatch-budget.json`](../scripts/quality/escape-hatch-budget.json),
> wired into the `lint` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

### A. What counts as an "escape hatch"

An *escape hatch* is any construct that suppresses or bypasses TypeScript's
type checking. This policy tracks six categories:

| Category id | Pattern | Why it's risky |
| --- | --- | --- |
| `as_any` | `as any` cast | Erases the type entirely; downstream access is unchecked. |
| `as_unknown` | `as unknown` cast (usually the bridge in `x as unknown as T`) | Launders one type into another, defeating structural checks. |
| `bare_any` | bare `: any` annotation | Opts a binding/param out of inference. |
| `ts_expect_error` | `@ts-expect-error` | Suppresses a specific compiler diagnostic. |
| `ts_ignore` | `@ts-ignore` | Suppresses *all* diagnostics on the next line (worse than `expect-error`, and already banned in prod by the Biome `noTsIgnore` rule — §1.3). |
| `biome_ignore` | `biome-ignore` | Suppresses a lint diagnostic. |

**Scope note (non-null `!`).** This policy deliberately does **not** budget the
non-null assertion operator (`x!`). It is far more frequent, far lower-risk in
this codebase (mostly post-guard narrowing), and a line-grep for `!` is too
noisy to be a meaningful ratchet. Non-null assertions on genuinely risky
boundaries should still carry a `// SAFETY:` comment (rule B.2) but are not
counted by the gate. This is an explicit, intentional limitation — not an
oversight.

**Methodology / precision.** Counts are **line-grep directional totals**, the
same method as §1.8 (one match per pattern per line; comments and doc-strings
that contain the literal token are counted; a `x as unknown as T` double-cast
counts once for `as_unknown` and once for `as_any`-if-present). They are a
*ratchet signal*, not an AST-precise unsafe-cast inventory. The contract is
narrow and sufficient: **production counts must not grow without a deliberate,
reviewed baseline bump.**

### B. Policy — when a production escape hatch is allowed

1. **Prefer elimination.** The first option is always to remove the need for the
   cast: validate at the boundary with Zod (`.safeParse`/`.parse`), narrow with
   a type guard, or fix the upstream type. Roadmap items **P2** (strict-flag
   ratchet) and **P3** (boundary-cast reduction) in §4.2 are the standing
   campaigns to shrink this budget.
2. **If unavoidable, document it inline.** Every *new* production escape hatch
   MUST carry an adjacent rationale comment in the form:

   ```ts
   // SAFETY: <one-line justification — what invariant makes this cast sound,
   //          and why the type system can't see it>
   const row = stmt.get(id) as unknown as TaskRow;
   ```

   The convention is the literal prefix **`// SAFETY:`** on the line above (or
   trailing, for a single statement). `// escape-hatch:` is accepted as a
   synonym. The justification must name the *invariant* (e.g. "row shape is
   guaranteed by the adjacent `CREATE TABLE` schema"), not merely restate that a
   cast is happening.
3. **Cluster at known boundaries.** Acceptable production casts cluster at the
   documented edges (§1.8): SQLite row mapping (funnel through
   [`src/repositories/row-mapper.ts`](../src/repositories/row-mapper.ts)), MCP
   `structuredContent`, Slack Block Kit, SSE event filtering, and Fastify
   plugin registration. A cast *outside* these boundaries should be treated as a
   review red flag even if the budget still passes.
4. **`@ts-ignore` stays banned in production** (Biome `noTsIgnore`, §1.3). If a
   diagnostic genuinely must be suppressed, use `@ts-expect-error` with a
   `// SAFETY:` reason — never `@ts-ignore`.
5. **Adding to the budget is a reviewed act.** Raising any `production.<category>`
   ceiling in the baseline JSON is a normal code-review event: the diff shows the
   bump, and rule B.2 requires the inline `// SAFETY:` to land in the same PR.
   The gate's job is to make the increase *visible*, not impossible.

### C. Test-only escape hatches — handled separately (lenient)

Test files (`*.test.ts`, `*.spec.ts`, `*.property.test.ts`, `*.bench.ts`, and
anything under `__tests__/`) are governed by a **deliberately more lenient**
policy and are **NOT** gated:

- Test escape hatches are largely fixture scaffolding, deliberate type-violation
  assertions (e.g. the 7 `@ts-expect-error` in `identity-types` /
  `fastify-augmentation` / `auth-audit` — §1.8), and mock shaping. They are
  expected and acceptable.
- The budget script still **counts and reports** test escapes (the
  "informational, NOT gated" block in its output) for visibility/trend, but they
  never fail CI.
- The `// SAFETY:` rationale is *encouraged but not required* in tests.

### D. Current production inventory (baseline at this commit)

Per-category production counts, reconciled against §1.8 and seeded into
[`scripts/quality/escape-hatch-budget.json`](../scripts/quality/escape-hatch-budget.json)
as the gate ceilings. Scan scope is `src/` **and** `packages/wft-router/src/`.

| Category | Production (baseline ceiling) | Test (informational) | Representative production refs |
| --- | :---: | :---: | --- |
| `as_any` | **10** | 57 | `src/services/task.service.ts:568`, `src/events/sse-manager.ts:161-162`, `src/api/routes/events.ts:129,145`, `src/api/server.ts:283` (Fastify SSE plugin), `src/services/dependency.service.ts:79` |
| `as_unknown` | **78** | 179 | clustered at SQLite row mapping, MCP `structuredContent`, Slack Block Kit; 3 live in `packages/wft-router/src` |
| `bare_any` | **1** | 38 | `src/cli/output/formatters.ts:26` |
| `ts_expect_error` | **0** | 7 | none in prod (all 7 in 3 test files) |
| `ts_ignore` | **0** | 0 | none (banned by Biome `noTsIgnore`) |
| `biome_ignore` | **0** | 0 | none |
| **TOTAL** | **89** | 281 | |

**Reconciliation vs. the wave-1 §1.8 census.** Wave-1 reported (main `src/`
only, one regex pass): `as any` non-test **10** ✓, `as unknown` non-test **75**,
`@ts-expect-error`/`@ts-ignore` **0** prod / **7** test ✓, bare `: any` **2**.
This policy's numbers differ on two categories, *with* evidence:

- **`as_unknown` 75 → 78.** +2 come from including `packages/wft-router/src` in
  the scan scope (wave-1's §1.8 counted main `src/` only — see its Known-Limit
  #6). +1 comes from a `debounce.ts` source file that contains a stray non-UTF8
  byte; plain `grep` reports `binary file matches` and silently drops the line,
  so the script forces text mode (`grep -a`) to count it deterministically.
- **`bare_any` 2 → 1.** Wave-1's `grep ': any\b'` counted 2 lines in main
  `src/`; re-inspected, only `src/cli/output/formatters.ts:26` matches under the
  same pattern at this commit, and it is a **comment** ("any value = disable"),
  not a real annotation — a known artifact of line-grep imprecision (Known-Limit
  #5). The budget treats it as a ceiling regardless; the point is "don't grow",
  not "this is a genuine unsafe annotation."

Neither delta contradicts wave-1's findings; both are explained by scan scope
and grep mechanics, consistent with §6 Known Limits #5 and #6.

### E. The CI gate (script behavior)

[`scripts/quality/escape-hatch-budget.mjs`](../scripts/quality/escape-hatch-budget.mjs)
(Node ESM, zero new deps — `node:fs` + `node:child_process` `grep`):

- **`node scripts/quality/escape-hatch-budget.mjs`** — gate mode. Counts live
  production escapes per category, compares to the baseline ceilings, prints a
  production table + a separate (non-gating) test census, and **exits 1** if any
  production category exceeds its ceiling (with the offending category, the
  delta, and representative file:line refs), else **exits 0**.
- **`--json`** — same comparison, machine-readable.
- **`--update`** — rewrite the baseline JSON to the current production+test
  counts. This is the **reviewed bump** mechanism (rule B.5): run it, eyeball the
  diff, and land it alongside the `// SAFETY:`-commented cast.

CI wiring: a step named *"Escape-hatch budget (fail on new unexplained
production casts)"* in the `lint` job of `ci.yml`. It is intentionally in the
cheap, build-free `lint` job so the ratchet reports fast on every PR.

**How the gate bites (verified).** Lowering any `production.<category>` ceiling
by 1 below the live count makes the script exit 1 with
`❌ Escape-hatch budget EXCEEDED in production code` and lists the over-budget
category and refs; restoring the baseline returns it to exit 0. This was
confirmed during task #766 by temporarily setting `production.as_any` from 10 to
9 (exit 1) and then restoring it (exit 0).

## Security & Dependency Automation Review

_Added for task #775 (project 37, phase 6). A read-only verification of the
repo's security and dependency-update automation as it stands today. Every
control below was confirmed by reading the actual config file; no secrets,
tokens, or local paths are reproduced here — only generic references._

### A. Current controls (each cited to a real file/setting)

**1. Dependabot — [`.github/dependabot.yml`](../.github/dependabot.yml)**

Two ecosystems are covered, both on a **weekly** cadence (Monday 06:00
`Etc/UTC`):

- `npm` (root `/`): `open-pull-requests-limit: 10`; grouped into `npm-patch`
  (patch updates) and `npm-minor` (minor updates); labels
  `dependencies`, `automated`. Major npm bumps are intentionally **not**
  grouped, so each lands as its own reviewable PR.
- `github-actions` (root `/`): `open-pull-requests-limit: 5`; a single
  `gh-actions` group covering `patch`, `minor`, **and** `major`; labels
  `dependencies`, `github-actions`. This is what keeps the pinned-action
  SHAs (below) from going stale.

**2. npm audit gates — [`package.json`](../package.json) + [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)**

The production audit is a **hard gate** in three independent places, all using
the same command `npm audit --omit=dev --audit-level=high`:

- CI `audit` job (`ci.yml`) — runs on every PR and push; fails the build on a
  high/critical advisory in production dependencies.
- `quality` script (`package.json`) — the full local gate
  (`build && test && lint && lint:deps && depcruise && npm audit --omit=dev
  --audit-level=high`). `quality:full` aliases it; `quality:fast` is the same
  chain **minus** the audit for inner-loop speed.
- `prepublishOnly` hook (`package.json`) — re-runs the audit as part of the
  release-safe subset, so a vulnerable prod dep blocks `npm publish` even if CI
  were bypassed.

**Dev-dependency advisory policy is explicit and intentional:** the `--omit=dev`
flag means dev-only advisories are **not** release blockers. This is documented
in [`docs/RELEASE.md`](./RELEASE.md) ("dev-dep audit advisory") and is the
deliberate posture — dev tooling CVEs are visible (`npm audit` without the flag
surfaces them) but do not gate merges or publishes.

**3. Pinned GitHub Actions — `.github/workflows/*.yml` (all six workflows)**

Every third-party action is pinned to a **full 40-character commit SHA** with a
trailing `# vX.Y.Z` comment for readability — never to a floating tag. Verified
across all `uses:` lines in `ci.yml`, `publish.yml`, `secret-scan.yml`,
`bench.yml`, `mutation.yml`, and `install-scripts.yml`. Actions in use:
`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
`actions/download-artifact`, `docker/setup-qemu-action`,
`docker/setup-buildx-action`, `docker/build-push-action` — all SHA-pinned. This
is the supply-chain mitigation against a compromised/retagged upstream action;
Dependabot's `github-actions` ecosystem (above) advances the SHAs on a reviewed
PR cadence.

**4. Least-privilege workflow permissions — all workflows**

Every workflow declares a top-level `permissions:` block. Five of six are
`contents: read` only. The lone exception is
[`publish.yml`](../.github/workflows/publish.yml), which adds `id-token: write`
solely to mint the OIDC token for npm trusted publishing — there is **no
long-lived `NPM_TOKEN` secret** in the repo. `publish.yml` also sets a
`concurrency` group with `cancel-in-progress: false` so two release runs cannot
race.

**5. Secret scanning + artifact hygiene — [`.github/workflows/secret-scan.yml`](../.github/workflows/secret-scan.yml)**

Two jobs, both required green on `main` before a release:

- **`gitleaks`** — full git-history scan. The CLI binary is installed directly
  from the upstream release (downloaded then verified with a pinned
  `sha256sum -c`), deliberately avoiding the now paid-for-orgs
  `gitleaks-action`. Allowlist lives in `.gitleaks.toml`. SARIF report uploaded
  as an artifact.
- **`hygiene`** — fails if any tracked file matches sensitive patterns
  (`.env*` except `.env.example`, `data/*.db`, `*.pem`, `*.key`) and runs
  `npm run pack:check` to confirm the publish tarball stays clean.

Triggers: `pull_request` → `main`, `push` → `main`, a **weekly** Monday 08:00
UTC `schedule` cron, and manual `workflow_dispatch`. The workflow header also
records that no untrusted user input (issue/PR titles, comment bodies) is
interpolated into any `run:` block — a script-injection mitigation.

**6. Auth / MCP / Slack-sensitive surface coverage — [`SECURITY.md`](../SECURITY.md)**

`SECURITY.md` is current and covers the sensitive surfaces explicitly:

- **Scope** names the Fastify REST API (`src/api/`), **both** MCP transports
  (stdio + remote HTTP under `src/mcp/`), the CLI (`src/cli/`), and the Slack
  integration (`src/slack/`, including signed-request verification and the
  EventBus → Slack notifier).
- **Security-relevant issues** call out auth bypass, secret/Slack-token
  exposure, pino redaction gaps, SQL/FTS5 injection, SSRF, MCP prompt-injection
  vectors, and Slack signature-verification/replay bypass.
- The **Authentication Architecture** and **"Authentication Is Not
  Authorization"** sections document the PAT / OIDC-session / legacy
  `X-API-Key` chain, the no-RBAC full-access credential model, the
  "run production behind HTTPS" cookie footgun, and the "never add
  reflect-any-origin CORS with credentials" warning.
- Supported-versions table lists `v1.17` as latest with `main` (HEAD); this is
  the field most prone to drift and should be bumped each release.

### B. Gaps / risks (current, honest)

1. **Branch-protection ↔ RELEASE.md drift is manual.** `docs/RELEASE.md`
   explicitly states there is "no automated drift detector yet" between the
   required-status-checks table and the live branch-protection API rule.
   A required check renamed in CI but not in the protection rule (or vice
   versa) is caught only by a human.
2. **`SECURITY.md` supported-version table is hand-maintained.** It currently
   reads `v1.17`; nothing fails CI if a release forgets to bump it. Low
   severity but it is the most visible staleness vector.
3. **Dev-dependency advisories are non-gating by policy.** Correct for release
   velocity, but it means a high-severity dev-tooling CVE (e.g. a build/test
   dep) is visible only to whoever runs a bare `npm audit`. No scheduled job
   surfaces dev advisories on a cadence.
4. **Dependabot has no `npm` security-update-only escalation channel.** It runs
   weekly for version bumps; GitHub's security updates are separate and depend
   on Dependabot alerts being enabled at the repo level (not assertable from
   the checked-in config alone).
5. **`enforce_admins: false`** (per RELEASE.md) means an admin can merge over a
   failing required check. Intentional for operator flexibility, but it is a
   policy-level bypass of the gates above.

### C. Prioritized recommendations

1. **(Low effort, high value)** Add a lightweight CI check, or a release-time
   checklist line, that fails/flags when the `SECURITY.md` supported-version
   table's "latest" tag does not match the newest git tag — closes gap B.2.
2. **(Medium)** Add the branch-protection drift detector RELEASE.md already
   wishes for: a scheduled job diffing the required-checks table against
   `gh api .../branches/main/protection` — closes gap B.1.
3. **(Low)** Run a **non-gating** dev-dependency `npm audit` (without
   `--omit=dev`) on the existing weekly secret-scan cron and surface the result
   as an advisory artifact, so dev CVEs get periodic visibility without
   blocking merges — addresses gap B.3 while preserving the explicit policy.
4. **(Process)** Confirm Dependabot **security updates + alerts** are enabled at
   the repository settings level (not just the version-update schedule in
   `dependabot.yml`) — addresses gap B.4.

### D. Self-attestation

No secret, token, password, API key, or local absolute path was introduced by
this section — only generic references to env-var *names* (`NPM_TOKEN`,
`SESSION_COOKIE_SECRET`, `API_KEYS`) as they already appear in the cited docs,
never any value. All controls were verified by reading the live config files
listed above.

## Repository Row-Mapping & SQLite Binding Boundaries

> Audit task #770. Scope: `src/repositories/**`. Goal: every repository method
> that reads nullable / date / tag-bearing rows funnels through the shared
> `row-mapper.ts` (or an explicitly justified local mapper); dynamic SQL
> update/filter builders avoid `Record<string, any>`; the legitimate
> better-sqlite3 boundary casts that remain are documented with rationale.

### A. Shared mapper contract

`src/repositories/row-mapper.ts` exports two helpers that are the single
sanctioned `unknown → RowType` boundary for the repo layer:

- `mapRow<T>(stmt, ...args): T | undefined` — wraps `stmt.get(...args)`.
- `mapRows<T>(stmt, ...args): T[]` — wraps `stmt.all(...args)`.

`better-sqlite3` returns `unknown` from `.get()` / `.all()` because it has no
knowledge of the column types the caller expects, so a cast is unavoidable at
that boundary. Centralising it in these two helpers means
`grep "as " src/repositories/` only surfaces genuine edge cases, and a future
runtime row validator (e.g. Zod) is a one-file change.

### B. Audit result — read-path compliance

Every method reading nullable / date / tag-bearing rows now reads through the
shared mapper or a justified local mapper:

| Repository | Read paths | Mapper status |
| --- | --- | --- |
| `api-token` | `findById`, `findByHash`, `listByUser` | `mapRow` / `mapRows` — compliant |
| `comment` | `findByTaskId`, `findById`, `countByTaskId` | `mapRow` / `mapRows` — compliant |
| `dependency` | `findAll`, `findByTaskId`, `findBlockingTask` | `mapRows` — compliant |
| `project` | `findById`, `findByName`, `findAll`, `count` | `mapRow` / `mapRows` + justified `inflateValueCharter` JSON local mapper — compliant |
| `task` | `findById`, `findAll`, `findByFilters` | `mapRow` / `mapRows` + justified `inflateVerificationEvidence` / `inflateWsjf` JSON local mappers — compliant |
| `user` | `findById`, `findByOidcSub`, `findBySlackUserId`, `findByEmail`, `findLegacy…`, `findServiceAccountByName`, `listAll`, **`insert`**, **`updateProfile`** | `mapRow` / `mapRows` — compliant **after this audit** (see §C) |
| `wsjf-history` | `findByTaskId`, `countByTaskId` | `mapRows` / `mapRow` raw read + justified field-by-field projection with `parseJson` JSON local mapper — compliant |
| `wsjf-rescore` | `findById` | `mapRow` raw read + justified field projection — compliant |
| `project-charter-history` | `findByProjectId`, `countByProjectId` | `mapRows` raw read + justified `parseCharter` field projection — compliant |

**Justified local mappers.** Three repositories (`task`, `wsjf-history`,
`wsjf-rescore`, `project-charter-history`, `project`) read the raw row through
the shared `mapRow`/`mapRows` and then run a *field-by-field projection* that
the generic mapper cannot express: TEXT columns holding JSON
(`verification_evidence`, `value_charter`, the `wsjf_*` metadata members, the
history `classifications`/`features`/`evidence`/`source`/`locked` slots) are
defensively parsed (`parseJson` / `parseCharter` / `parseVerificationEvidence`
— non-JSON → `null`, never throws). This is an *explicitly justified* local
mapper layered on top of the shared read, not a bypass: the `unknown → row`
boundary is still the shared helper; the projection only shapes already-typed
TEXT into typed objects.

### C. Drift fixed by this audit

`user.repository.ts` had two write-then-read methods that bypassed the shared
mapper by casting a `RETURNING *` row directly:

- `insert(...)` — was `this.insertStmt.get(...) as User | undefined`.
- `updateProfile(...)` — was `this.db.prepare(sql).get(...) as User | undefined`.

Both read a `users` row whose `email` column is nullable, so they belong in the
shared-mapper boundary. They now read through `mapRow<User>(...)`. This is a
**pure type-tightening / boundary-consolidation change with no runtime behavior
change** — `mapRow<User>` performs exactly the same `stmt.get(...) as User |
undefined` it previously inlined. The existing `insert` and `updateProfile`
test blocks in `user.repository.test.ts` (including the nullable-`email`
round-trip cases) continue to pass unchanged, so no new test was added.

### D. Dynamic SQL update/filter builders

No `Record<string, any>` exists in any repository source. The dynamic builders
already use precise types:

- Named-parameter accumulators (`task.update`, `task.findByFilters`,
  `project.update`) use `SqlParams = Record<string, SqlParamValue>` where
  `SqlParamValue = string | number | null` (`src/repositories/types.ts`).
- The positional builder in `user.updateProfile` uses
  `Array<string | null>` — already as narrow as its columns (`email`,
  `display_name`) allow.

`grep -rn "Record<string, any>" src/repositories --include=*.ts` returns a
single hit: a *comment* in `types.ts` describing the historical pattern that
`SqlParamValue` replaced. No code occurrence exists before or after this audit.

### E. Remaining justified better-sqlite3 boundary casts

These casts legitimately stay — they are the irreducible interface seam with
better-sqlite3's untyped surface:

1. **`info.lastInsertRowid`** — typed `number | bigint` by better-sqlite3. The
   repos narrow it at the write boundary:
   - `api-token.repository.ts` uses `Number(info.lastInsertRowid)` (safest —
     coerces the `bigint` branch).
   - `comment`, `dependency`, `project`, `task`, `wsjf-history`,
     `wsjf-rescore`, `project-charter-history` use `info.lastInsertRowid as
     number`. Justified because every `INTEGER PRIMARY KEY` in this schema is
     well within `Number.MAX_SAFE_INTEGER`; better-sqlite3 only returns the
     `bigint` branch when a rowid exceeds 2^53, which this app's id space never
     reaches. (`Number(...)` is the marginally safer idiom but the `as number`
     cast is sound for this schema.)
2. **`unknown[]` rest-args on the mapper helpers** (`mapRow`/`mapRows`
   signatures) — deliberately structural so callers pass either a prepared
   `Database.Statement` or a `db.prepare(...)` chain without coupling the helper
   to better-sqlite3's full generic surface.
3. **Per-field projection casts** (`row.x as number | null`, `row.x as string`)
   in the JSON-bearing repos (§B) — applied *after* the shared `mapRow`/
   `mapRows` read, on a `Record<string, unknown>` row, to shape individual
   columns the generic `mapRow<T>` can't express alongside JSON parsing.
4. **`as { count: number }`** on `COUNT(*)` projections — a trivially-shaped
   scalar row read through `mapRow`; the cast names the single aggregate column.

### F. Self-attestation

No secret, token, password, API key, or absolute local path was introduced.
Changes were limited to `src/repositories/user.repository.ts` (route two reads
through `mapRow<User>`) and this appended section. `tsc --noEmit`, Biome lint,
and `vitest run src/repositories` (154 tests) all pass.
