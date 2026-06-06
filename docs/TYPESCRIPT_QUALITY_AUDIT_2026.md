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
| `exactOptionalPropertyTypes` | **ON** | explicit (ratcheted task #780; see §778/§G) |
| `noUncheckedIndexedAccess` | **ON** | explicit (ratcheted task #784; see §784) |

Other compiler settings: `target: ES2022`, `module/moduleResolution: Node16`,
`declaration: true`, `sourceMap: true`, `skipLibCheck: true`,
`resolveJsonModule: true`. `rootDir: ./src`, `outDir: ./dist`. Tests/benches
are excluded from the production compile (`**/*.test.ts`, `**/*.bench.ts`,
`**/__tests__/**`). TypeScript dep is `typescript@^6.0.3`; Node engine is
`>=22`.

**Strict-flag ratchet status.** All three formerly-deferred strict flags are now
ON: `noPropertyAccessFromIndexSignature` (#763), `exactOptionalPropertyTypes`
(#780), and `noUncheckedIndexedAccess` (#784, this row). The latter forces
`T | undefined` at every index / array / record access; it landed green after the
#782 (core) + #783 (surface) remediation passes. See §784 for the closeout note
and the residual pre-existing bracket-index assertions that survived because they
were already `!`-suppressed before the audit (so they produced 0 probe errors).

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

- **UPDATED (§777, 2026-06-06):** `formatter.enabled` is now **`true`** and the
  formatter is a **live CI gate**. `format:check` = `biome format .`, runs as a
  step in the `lint` CI job, and is chained into `npm run quality`. The text
  below describes the **baseline `a872170` state** and is retained as history.
- *(baseline)* `formatter.enabled` = **`false`**. This was intentional and
  load-bearing: the `package.json` `format:check` script was hard-wired to
  `exit 1` with an explanatory message. There was **no format gate in CI or in
  `npm run quality`**.
- *(baseline)* A full formatter *config* existed (indentWidth 2, lineWidth 100,
  single quotes, semicolons always, trailing commas all) but was dormant until
  `formatter.enabled: true` plus a one-time reformat sweep landed (since done).
- **Evidence finding (RESOLVED):** at baseline `biome.json`'s `$schema` pinned
  **2.4.15** while the installed `@biomejs/biome` was **2.4.16**, emitting one
  **info** diagnostic. As of §777 the schema is pinned to **2.4.16** and `npm
  run lint` is clean with **0 info**.

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
- **UPDATED (§777):** `format:check` (`biome format .`) **IS now a CI gate** — a
  step in the `lint` job (`ci.yml:85-86`), alongside the escape-hatch budget
  step (`ci.yml:87-88`). The "NOT a CI gate" note below was the baseline state.
- *(baseline)* `format:check` was NOT a CI gate (formatter disabled — §1.2).
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

> **POST-MILESTONE NOTE (§777, 2026-06-06):** the table below is the **baseline
> `a872170`** reading. Project 37 has since moved several rows: "Full strict
> surface" → **Meets** (all 3 flags ON), "Formatter" → **Meets** (enabled +
> gated), "Runtime boundary validation" → improved (#774 response validation).
> See §777.B for the after-state scorecard. "Async safety" remains **Below**.

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

> **POST-MILESTONE NOTE (§777):** the scores below are the **baseline** snapshot.
> The after-milestone re-score (compiler strictness 3.5→5, formatting 1.5→4.5,
> CI/release 4.5→5, runtime-boundary 3.5→4) is in **§777.B**. Async safety (2)
> is unchanged and is the top recommended follow-up.

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

> **POST-MILESTONE NOTE (§777):** §4.2's P1–P8 were the baseline plan. By
> closeout: **P2 DONE** (all 3 strict flags ON, #763/#780/#784), **P3 partially
> DONE** (#774 response validation; MCP/Slack casts still budgeted),
> **P4 DONE** (schema drift resolved), **P5 DONE** (formatter enabled + gated),
> **P6/P7 DONE** (#772 mutation survivors / #771 complexity report),
> **P8 DONE** (this reconciliation + roadmap refresh). **P1 (async-safety lint)
> is the one open high-charter item** — see §777.E follow-up F1.

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

## exactOptionalPropertyTypes audit (#778)

> AUDIT/INVENTORY ONLY. The flag is **NOT** enabled — it was added to
> `tsconfig.json` temporarily to enumerate errors, then reverted. Enabling it
> is the downstream task **#780**; services/repos remediation is **#779**.
> `grep -n exactOptional tsconfig.json` returns nothing at this commit.

### A. How this was measured

Temporarily set `compilerOptions.exactOptionalPropertyTypes: true`, ran
`npx tsc --noEmit`, captured the error list, then reverted the one-line change.

```
# error-code histogram (43 errors total)
  32  TS2379   exact-optional argument mismatch (object literal → param)
   3  TS2412   `T | undefined` assigned into an exact-optional property slot
   3  TS2375   object-literal assignment with explicit-undefined prop
   3  TS2345   argument-not-assignable (Fastify server-type variance, NOT eopt)
   1  TS2769   no overload matches (Fastify http2 listen overload, NOT eopt)
   1  TS2322   type-not-assignable (Fastify instance variance, NOT eopt)
```

**Net eopt-attributable errors: 38** (TS2379 + TS2412 + TS2375). The 5
`src/api/server.ts` errors coded TS2345/TS2769/TS2322 are **pre-existing
Fastify Http2-vs-default `FastifyInstance` generic-variance noise** that the
flag surfaces incidentally — they are NOT exact-optional issues and must be
triaged separately by #780 (do not let them mask the real eopt count).

### B. Error CATEGORIES (root causes)

1. **Pagination passthrough `{ limit, offset }` — the single biggest cluster
   (9 of 38, ~24%).** Call sites build `{ limit: number | undefined, offset:
   number | undefined }` and pass it to a `{ limit?: number; offset?: number }`
   target (`PaginationOptions` / `PaginationParams`). The values come from
   parsed query/args where "absent" is modelled as `undefined`. Fix shape:
   conditional spread (`...(limit !== undefined && { limit })`) or a small
   `omitUndefined()` helper at the param-assembly boundary. Zero runtime change.
   - `src/repositories/task.repository.ts:531`
   - `src/mcp/tools/task-tools.ts:599`, `:725`
   - `src/mcp/tools/project-tools.ts:92`
   - `src/mcp/tools/comment-tools.ts:85`
   - `src/mcp/remote/register-tools.ts:391`, `:456`, `:617`, `:896`

2. **Create/Update DTO assembly (services → repos).** Object literals built
   from request input carry `prop?: T | undefined` and are passed into the
   exact-optional DTO params. These DTOs (`src/types/task.ts:270-379`) encode a
   **deliberate three-state convention**: key **absent** = "leave column
   untouched", explicit **`null`** = "clear column", **value** = "set". eopt
   makes that convention load-bearing at the type level: passing an explicit
   `undefined` is no longer the same as omitting the key, so the call sites must
   omit-when-undefined rather than widen the DTOs. **Do NOT widen the DTO props
   to `| undefined`** — that would re-flatten the absent-vs-undefined distinction
   the convention depends on. This is the #779 hotspot.
   - `CreateTaskDTO` builds: `src/services/task.service.ts:269`, `:280`
   - `UpdateTaskDTO` patches: `src/services/task.service.ts:526`, `:537`
   - `CreateProjectDTO` / `Partial<CreateProjectDTO>`:
     `src/services/project.service.ts:81`, `:192`
   - `CreateCommentDTO`: `src/services/comment.service.ts:43`
   - `VerificationEvidence`: `src/services/task.service.ts:445`
   - `TaskFilters` (filter-object assembly):
     `src/services/task.service.ts:340`, `:361`, `:365`, `:605`
   - `CompletionReportInput` / `CompletionRangeFilters`:
     `src/services/task.service.ts:690`, `:691`

3. **MCP remote tool input mapping.** The remote surface re-maps DTOs into its
   own `*Input` param types and hits the same explicit-undefined problem.
   - `CreateProjectInput`: `src/mcp/remote/register-tools.ts:551`
   - `UpdateProjectInput`: `src/mcp/remote/register-tools.ts:681`

4. **Class-property init with `T | undefined` (TS2412).** A constructor assigns
   a possibly-undefined value into a non-optional/exact-optional field.
   - `src/services/project.service.ts:52` (`IProjectCharterHistoryRepository`)
   - `src/services/project.service.ts:53` (`Database`)
   - `src/cli/api/client.ts:89` (`string`)

5. **Object-literal `metadata`/options with explicit-undefined prop (TS2375).**
   - `src/cli/output/json-output.ts:27` — **FIXED in this audit** (safe
     type-only conditional-spread; JSON.stringify already drops undefined keys).
   - `src/cli/commands/setup.ts:423` (`RunSetupResult`)
   - `src/services/task.service.ts:554` (`EventMetadata` — status `to` field)

6. **CLI/REST surface option objects (subset of TS2379).** Same omit-when-
   undefined fix; lowest-risk, leaf utilities.
   - `src/cli/prompts/interactive.ts:41` (`TextOptions`)
   - `src/cli/commands/serve.ts:101` (`ServeOptions`)
   - `src/cli/commands/mcp.ts:76` (`McpSelectionEnv`)
   - `src/cli/commands/setup.ts:420`, `:463` (`FixNpmPrefixOptions`,
     `RunSetupOptions`)
   - `src/api/routes/web/login.ts:32` (`RenderLoginOptions`)
   - `src/api/server.ts:400` (env-subset object → `{ OIDC_REDIRECT_URI?; PORT }`)

### C. Zod schema note

Zod `.optional()` produces `T | undefined` (NOT an omitted key), so any place a
parsed schema result is spread/forwarded into an exact-optional DTO inherits
this mismatch. The schema files (`src/schemas/*.schema.ts`) themselves produce
**no** eopt errors — the friction is entirely at the **consumption** boundary
where a `z.infer` result feeds a DTO/param. Remediation belongs at those call
sites (categories B/C above), not in the schemas. If a uniform fix is wanted,
`z.preprocess`/`.transform` to strip undefined keys, or a shared
`stripUndefined()` at the schema→service boundary, is the lever.

### D. Recommended remediation order (for #779 / #780)

1. **#779 (services/repos):** introduce a tiny `omitUndefined`/conditional-spread
   helper and apply it at the DTO-assembly and pagination-passthrough sites
   (categories 1, 2, 3, 4). Keep DTO interfaces as-is — the absent/null/value
   three-state convention is intentional and must be preserved.
2. **#780 (surfaces + enable):** fix the CLI/REST leaf option objects (category
   6), the two remaining TS2375 literals (category 5), then **separately**
   resolve the 5 Fastify Http2-variance errors in `src/api/server.ts` (these
   are NOT eopt), and only then flip `exactOptionalPropertyTypes: true`.

### E. Safe preparatory edit made by THIS task

- `src/cli/output/json-output.ts:27` — replaced `metadata,` with
  `...(metadata !== undefined && { metadata })`. Pure type-only / zero runtime
  change (JSON.stringify already omits undefined-valued keys). This is the only
  source edit; no behaviour-sensitive call site was touched.

### F2. Self-attestation (#778)

No secret, token, password, API key, or absolute local path was introduced. The
flag is reverted (`grep exactOptional tsconfig.json` → empty). The only source
change is the one safe `json-output.ts` edit above plus this audit section.
`npm run build` passes (exit 0) with the flag OFF.

> **Status update (#780):** the flag is now **ON** and permanent
> (`compilerOptions.exactOptionalPropertyTypes: true` in `tsconfig.json`). The
> "reverted" attestation above is the historical #778 state. See §G below.

### G. Optional-field policy (the eopt convention, owned by #780)

With `exactOptionalPropertyTypes: true` enabled permanently, the following
policy is **load-bearing** for all new and changed code. It is the convention
the #779/#780 remediation established:

1. **Prefer omitting `undefined` keys over widening to `| undefined`.** When an
   object literal or param-assembly site carries a possibly-`undefined` value
   into an exact-optional target (`prop?: T`), DO NOT add `| undefined` to the
   target's prop just to make the assignment type-check. Instead omit the key
   when the value is `undefined`:
   - **conditional spread** for one or two keys, keeping required keys inline:
     `{ name, ...(x !== undefined && { x }) }`;
   - **`omitUndefined(obj)`** (`src/utils/omit-undefined.ts`, mirrored at
     `packages/wft-router/src/util/omit-undefined.ts` for the standalone router
     package) when ALL keys are optional. Note `omitUndefined` maps every key to
     optional, so do NOT use it on objects with a **required** key (e.g.
     `CreateProjectInput.name`) — use a targeted conditional spread there.
   - **guarded assignment** for class fields: `if (v !== undefined) this.f = v;`
     (avoids TS2412 when a constructor threads a `T | undefined` dep into an
     exact-optional `field?: T`).

2. **Preserve the absent / `null` / value three-state.** The Create/Update DTOs
   (`src/types/task.ts`) and the project create/update inputs encode three
   distinct states: key **absent** = leave untouched, explicit **`null`** =
   clear, **value** = set. `omitUndefined` and the conditional spreads above
   strip only `undefined` — explicit `null` is preserved verbatim, so the
   "clear the column" semantics survive. NEVER collapse this distinction by
   widening a DTO/schema prop to `| undefined`.

3. **`| undefined` is acceptable only for genuinely internal helper params** whose
   contract treats "absent" and "undefined" identically with no three-state
   meaning (e.g. `effectiveOrigin(env: { OIDC_REDIRECT_URI?: string | undefined; … })`
   in `src/config/env.ts`, which already falls back to localhost for both). Do
   not reach for this on DTO/schema/REST boundaries.

4. **Fastify generic-variance footnote.** The 5–6 `src/api/server.ts`
   TS2345/2769/2322 errors the flag once surfaced were NOT eopt issues — they were
   a cascade from a single explicit `transport: undefined` in the logger options,
   which pushed TS onto Fastify's trailing Http2 `Fastify()` overload and made the
   inferred `FastifyInstance` `RawServer` generic disagree with the default-server
   `FastifyInstance` used downstream. Replacing `transport: … : undefined` with a
   conditional spread (`...(NODE_ENV === 'development' && { transport: … })`) so the
   key is genuinely absent collapses ALL of them — **no library-boundary cast was
   needed**. Reach for a localized, commented Fastify-SDK cast only if a future
   variance error genuinely has no clean omit/narrow fix (the #766 escape-hatch
   policy); none was required for #780.

### noUncheckedIndexedAccess inventory (#781)

> AUDIT / INVENTORY ONLY. The flag is **NOT** enabled — it was added to
> `tsconfig.json` temporarily to enumerate errors, then reverted. Enabling it
> permanently is the downstream task **#784**; core remediation is **#782**,
> surface remediation is **#783**. `grep -n noUncheckedIndexedAccess
> tsconfig.json` returns nothing at this commit. No source remediation was made
> here (this is inventory-only; the categories below are advisory for #782/#783).

#### A. How this was measured

Temporarily set `compilerOptions.noUncheckedIndexedAccess: true` (alongside the
already-permanent `exactOptionalPropertyTypes` / `noPropertyAccessFromIndexSignature`),
ran `npx tsc --noEmit`, captured the error list, then reverted the one-line change.

```
# error-code histogram (30 errors total)
  15  TS18048   '<name>' is possibly 'undefined'   (indexed value used after binding)
   5  TS2532    Object is possibly 'undefined'      (arr[i].member / arr[i][j] inline)
   5  TS2345    arg 'T | undefined' not assignable to param 'T'  (indexed value → fn)
   4  TS2322    type 'T | undefined' not assignable to 'T'/'T|null' (indexed value → slot)
   1  TS2538    Type 'undefined' cannot be used as an index type  (nested arr[arr[i]])
```

All 30 are genuine indexed-access narrowings — there is **no** incidental
library-variance noise class here (contrast the eopt #778 probe, which dragged in
5 Fastify Http2 errors). Every error is a `T[number]` / `Record<K,V>[K]` / tuple
access that the flag correctly re-types to `T | undefined`.

#### B. Error CATEGORIES (root causes)

1. **Classic index-loop body (`const x = arr[i]; … x.member`) — the dominant
   cluster.** A `for (let i …)` or manual `head++` cursor reads `arr[i]` into a
   local, then dereferences it. The loop bound already guarantees the index is
   in range, so the value is provably present, but the flag cannot see that.
   - `src/api/plugins/auth/keys.ts:77,81,83,86` (`const k = keys[i]; k.length …`)
   - `src/config/env.ts:349` (`rawParts[i].trim()`)
   - `src/services/wsjf-health.service.ts:298` (`series[i] - series[i-1]`)
   - `src/services/dependency-graph.service.ts:502` (`childIds[i]` in walk loop)

2. **Manual queue/cursor dereference (`queue[head++]`, `bufferStack[len-1]`).**
   BFS/transaction-stack code advances a hand-rolled cursor or peeks the top of
   a stack guarded by a separate `length` check. Same "provably present, not
   provable to TS" shape as (1).
   - `src/events/event-bus.ts:76` (`bufferStack[length-1].push(...)`)
   - `src/events/event-bus.ts:114` (`const parent = bufferStack[length-1]`)
   - `src/services/wsjf-rescore.service.ts:419` (`const cur = queue[head++]`)
   - (the sibling `queue[head++]` in `wsjf.service.ts` is already `!`-guarded —
     see the no-blanket-`!` rule in §D; #782 should replace that existing `!`
     too, not pattern-match it.)

3. **Destructured-pair / record-lookup `*.deltas['key']` used field-by-field.**
   A `Record<string, {from,to}>` lookup is bound to `s` then `s.from`/`s.to` are
   read. The key is known-present from the producer, but the lookup type is
   `… | undefined`. This is the same code mirrored on two surfaces:
   - `src/mcp/tools/wsjf-tools.ts:165,166` (`const s = entry.deltas['wsjf_score']`)
   - `src/mcp/remote/register-tools.ts:1163,1164` (identical block, remote copy)

4. **Indexed value flowed straight into a typed param / slot (TS2345 / TS2322).**
   An `arr[i]` / `Map.get`-style indexed read is passed to a function or assigned
   to a `number` / `number|null` field without an intervening local, so the
   `| undefined` hits the call/assignment boundary directly.
   - `src/services/wsjf.service.ts:176` (`return FIB[ordinals[mid]]` → `Fib`)
   - `src/services/wsjf.service.ts:742,743` (indexed ordinals → numeric fn args)
   - `src/services/dependency-graph.service.ts:232` (`allIdsSorted[0]` → `number`)
   - `src/services/topology.service.ts:143` (`held.from`,`held.to` → detector args;
     `held = edges[i]` upstream)
   - `src/services/device-flow-store.ts:132` (`USER_CODE_ALPHABET[byte % 31]` →
     `string` push; modulo keeps it in range but TS sees `| undefined`)
   - `src/cli/commands/db-check.ts:30` (`integrityResults[0].integrity_check`)
   - `src/cli/commands/db-migrate-identities.ts:149` (`aliasMap[value]` → `number|null`,
     guarded by a prior `hasOwnProperty` the flag does not credit)
   - `src/cli/commands/docs.ts:76` (`file: string | undefined` from a `.map`
     element flowing into `DocEntry.file: string`)

5. **Nested index used as an index type (TS2538).** `FIB[ordinals[mid]]` — the
   inner `ordinals[mid]` is `number | undefined`, and `undefined` is not a legal
   array index type. One occurrence; same site as category 4's `wsjf.service.ts`.
   - `src/services/wsjf.service.ts:907`

#### C. High-risk arrays/maps/dictionaries BY LAYER

**CORE — services / repositories / utilities / events (14 errors):**
- `src/services/wsjf.service.ts` (4) — `FIB` fibonacci lookup table + `ordinals[]`
  median math; **fixed-shape numeric tables → strongest tuple-type candidate.**
- `src/services/wsjf-health.service.ts` (2) — `series[i]` trend deltas.
- `src/services/topology.service.ts` (2) — `edges[i]` (`held`) cycle-detect input.
- `src/services/dependency-graph.service.ts` (2) — `allIdsSorted[0]` root pick +
  `childIds[i]` tree walk.
- `src/services/wsjf-rescore.service.ts` (1) — BFS `queue[head++]`.
- `src/services/device-flow-store.ts` (1) — `USER_CODE_ALPHABET[byte % 31]`.
- `src/events/event-bus.ts` (2) — `bufferStack[length-1]` transaction-stack peek.
- repositories / utils: **0 errors** — `src/repositories/**` and `src/utils/**`
  are already clean under the flag (note for #782: nothing to do there).

**SURFACE — api / cli / mcp / slack / web / router (15 errors):**
- `src/api/plugins/auth/keys.ts` (4) — `keys[i]` API-key validation loop.
- `src/mcp/tools/wsjf-tools.ts` (4) — `entry.deltas['wsjf_score']` history render.
- `src/mcp/remote/register-tools.ts` (4) — identical `deltas['wsjf_score']` block
  (remote mirror of wsjf-tools; fix both copies the same way).
- `src/cli/commands/db-check.ts` (1) — `integrityResults[0]`.
- `src/cli/commands/db-migrate-identities.ts` (1) — `aliasMap[value]`.
- `src/cli/commands/docs.ts` (1) — `.map` element → `DocEntry`.
- slack / web / router: **0 errors** under the flag.

**Boundary call:** `src/config/env.ts:349` (1, `rawParts[i]`) is config glue, not a
service. It is assigned to **#782 (core)** to keep the #783 list purely on the
outward-facing api/cli/mcp surfaces — giving #782 = 15 and #783 = 15 (see §E).

#### D. APPROVED fix patterns (and the no-blanket-`!` rule)

> **REJECTED: blanket non-null assertion.** Do NOT remediate by sprinkling
> `arr[i]!`, `map.get(k)!`, or `x!.member`. A bare `!` silently re-introduces
> exactly the runtime-`undefined` hazard the flag exists to surface, and it
> survives later refactors that change the bound/producer. The existing
> `distance.get(cur)!` in `src/services/wsjf.service.ts` is the anti-pattern to
> retire, not to copy. Each error below MUST resolve via one of patterns 1–4.

1. **Guard-and-bind (default for categories 1, 2, 3).** Read once into a local,
   test for `undefined`, and either `continue`/`break`/early-return or narrow:
   ```ts
   const k = keys[i];
   if (k === undefined) continue;     // or: throw / break, per loop intent
   // k is now `string`
   ```
   For stack/queue peeks where emptiness is impossible by construction but you
   still want a tripwire, throw an explicit invariant error rather than `!`:
   ```ts
   const cur = queue[head++];
   if (cur === undefined) throw new Error('queue cursor out of range');
   ```

2. **Tuple / fixed-shape types (preferred for category 4/5 numeric tables).**
   Where the array is a compile-time-fixed table (`FIB`, fixed ordinal maps),
   type it as a readonly tuple or `as const` so individual indices are typed
   present, and clamp the index to the valid domain before lookup. This removes
   the `| undefined` at the *type* level instead of asserting it away at each use.
   For computed indices that genuinely can fall out of range, narrow the index
   first (`if (idx < 0 || idx >= FIB.length) …`) — never index with a
   possibly-`undefined` value (the TS2538 site).

3. **Typed accessor helper (for repeated record/array lookups).** Mirror the
   existing `src/utils/omit-undefined.ts` style with a tiny, well-named accessor
   that centralizes the guard and gives a meaningful throw site, e.g.
   `atOrThrow(arr, i, msg)` / `requireKey(record, key)`. Use this where the same
   "known-present lookup" appears repeatedly (the duplicated `deltas['wsjf_score']`
   block across wsjf-tools + register-tools is the textbook case). Keep it in
   `src/utils/` so both core and surface can import it. **PROPOSED here; the
   helper is implemented by #782 if #782 adopts it, then reused by #783.**

4. **Explicit empty-state handling (for category 4 "first element" reads).** Where
   `arr[0]` is read after a `length > 0` check (`allIdsSorted[0]`,
   `integrityResults[0]`), restructure so the empty case is handled explicitly —
   destructure with a default, `if (arr.length === 0) return …`, or
   `const [first] = arr; if (first === undefined) …` — so the non-empty branch
   carries a present-typed value.

For `hasOwnProperty`-guarded record reads (`aliasMap[value]`, TS2322) the flag
does not credit the guard; bind the lookup to a local and `=== undefined`-check it
(pattern 1), or use the pattern-3 `requireKey` accessor.

#### E. Scoped worklists for the split tasks

**#782 — CORE (services + repositories + utilities + events; 15 errors):**
| File | Count | Codes | Pattern |
|---|---|---|---|
| `src/services/wsjf.service.ts` | 4 | TS2322, TS2345×2, TS2538 | tuple type (2) + index-narrow (2) |
| `src/services/wsjf-health.service.ts` | 2 | TS2532 | guard-and-bind (1) |
| `src/services/topology.service.ts` | 2 | TS18048 | guard-and-bind (1) |
| `src/services/dependency-graph.service.ts` | 2 | TS2322, TS2345 | empty-state (4) + guard (1) |
| `src/services/wsjf-rescore.service.ts` | 1 | TS2345 | guard-and-bind (1) |
| `src/services/device-flow-store.ts` | 1 | TS2345 | guard-and-bind (1) |
| `src/events/event-bus.ts` | 2 | TS2532, TS18048 | guard-and-bind (1) |
| `src/config/env.ts` | 1 | TS2532 | guard-and-bind (1) |
- Also retire the pre-existing `distance.get(cur)!` in `wsjf.service.ts` while in
  the file (no-blanket-`!` rule). Repositories/utils have **0** errors.
- If #782 introduces the pattern-3 `src/utils/` accessor helper, land it here so
  #783 can import it.

**#783 — SURFACE (api + cli + mcp + slack + web + router; 15 errors):**
| File | Count | Codes | Pattern |
|---|---|---|---|
| `src/api/plugins/auth/keys.ts` | 4 | TS18048 | guard-and-bind (1) |
| `src/mcp/tools/wsjf-tools.ts` | 4 | TS18048 | guard / accessor (1 or 3) |
| `src/mcp/remote/register-tools.ts` | 4 | TS18048 | guard / accessor (1 or 3) — same block as wsjf-tools |
| `src/cli/commands/db-check.ts` | 1 | TS2532 | empty-state (4) |
| `src/cli/commands/db-migrate-identities.ts` | 1 | TS2322 | guard-and-bind (1) |
| `src/cli/commands/docs.ts` | 1 | TS2322 | guard / map-element fix (1) |
- slack / web / router: **0** errors. The two `deltas['wsjf_score']` blocks
  (wsjf-tools + register-tools) are duplicates — fix identically (ideal consumer
  for the pattern-3 accessor if #782 ships it).

**#784 — ENABLE:** after #782 + #783 land green, flip
`noUncheckedIndexedAccess: true` permanently and add it to the ratchet table in §A.
Re-run the probe to confirm 0 residual errors before flipping (BFS/queue code and
the duplicated MCP blocks are the regression-prone spots to re-check).

#### F. Self-attestation (#781)

No secret, token, password, API key, or absolute local path was introduced. The
flag is reverted (`grep -n noUncheckedIndexedAccess tsconfig.json` → empty). This
task made **no** source edits — the deliverable is this inventory section only.
`npm run build` passes (exit 0) with the flag OFF.

### §784 — noUncheckedIndexedAccess ENABLED (closeout)

**Status: ON, ratcheted (#784).** `noUncheckedIndexedAccess: true` is now a
permanent line in `tsconfig.json` (added directly after `exactOptionalPropertyTypes`;
`grep -n noUncheckedIndexedAccess tsconfig.json` → line 20). The root tsconfig is
`extends`-ed by `packages/wft-router/tsconfig.json`, so the flag covers the router
compile as well — the full `npm run build` (`tsc && tsc -p packages/wft-router &&
build:skills`) exits 0 with the flag on.

- **Flag enabled** permanently; one-line change to `tsconfig.json`.
- **30 errors resolved** across core (#782, 15) + surface (#783, 15) before this
  flip. The #784 flip itself surfaced **zero** new `tsc` errors — a clean flag-flip.
- **Zero escape hatches introduced by #782/#783/#784.** The pre-existing
  `distance.get(cur)!` anti-pattern called out in §D was retired by #782
  (`src/services/wsjf.service.ts:746` is now an unasserted `distance.get(cur)`
  guarded read). No new blanket `!` were added to force the build green.
- **Tests green:** `npx vitest run src/services src/api src/cli src/mcp` →
  189 files / 2218 tests passed (exit 0), covering the #782/#783 fallback-behavior
  suites.

#### Remaining bracket-index assertions (pre-existing, NOT introduced here)

The audit's "zero remaining blanket `!`" expectation holds for every file on the
#782/#783 worklists. However, the flag-enable surfaced **4 pre-existing**
bracket-index `!` assertions in files that were **never on the #781 inventory
worklists** — precisely because they were *already* `!`-suppressed before the
audit, so they emitted 0 errors in the #781 probe and never appeared as remediation
targets. They are flag-governed (`arr[i]` / `arr[0]` index access) and remain as
documented escape hatches:

| File:line | Expression | Shape |
|---|---|---|
| `src/slack/formatters/project-formatter.ts:45` | `projects[i]!` | classic `for (i…)` index-loop body |
| `src/slack/notifier.ts:99` | `results[i]!` | classic `for (i…)` index-loop body |
| `src/slack/commands/tasks-command.ts:109` | `args[i]!` | classic `for (i…)` arg-parse loop |
| `src/events/sse-manager.ts:203` | `this.eventBuffer[0]!.id` | first-element read after `length > 0` |

All four are the §B-category-1 / category-4 shapes the §D guard-and-bind (pattern 1)
and empty-state (pattern 4) fixes were designed for. They were **left untouched by
#784** (this task is a flag-flip + doc closeout and explicitly does not edit source
to silence or refactor errors — and these produce no errors today because the `!`
already neutralizes them). **Follow-up:** a small mop-up task should replace these 4
with guard-and-bind / empty-state handling per §D to bring the no-blanket-`!` rule to
100% coverage across the index-access surface (slack/ and events/sse-manager were
out of #782/#783 scope). Note these are NOT regressions — they pre-date the audit.

---

## §777 — Final quality ratchet review (project-37 closeout)

> **Project 37, final task #777.** This is the milestone's closeout deliverable
> and the evidence anchor for closing project 37. It records the verification
> commands + dates, a before→after scorecard, confirms every landed gate is
> reflected in CI / the PR template / the docs (and fixes the spots that were
> stale), marks the strictness ratchets DONE rather than "planned", and captures
> the remaining high-value gaps as explicit recommended follow-up tasks for a
> human to promote. No task API was called and no tasks were created by this
> review — the follow-ups in §777.E are a planning list only.

### §777.A — Verification commands + dates

Run from the worktree root on **2026-06-06**, on `feat/typescript-quality-audit`
at HEAD `7c1b051` (tip = #784, the strictness-ratchet close):

```bash
# Base / tree identity
git rev-parse HEAD                       # 7c1b051… (#784 descendant)
git log --oneline -15                    # confirms #763,#774,#771,#773,#778,#779,
                                         #   #780,#772,#781,#782,#783,#784 all landed

# Active strictness flags (all three now ON, permanent)
grep -nE "noPropertyAccessFromIndexSignature|exactOptionalPropertyTypes|noUncheckedIndexedAccess" tsconfig.json
#   18: noPropertyAccessFromIndexSignature: true
#   19: exactOptionalPropertyTypes: true
#   20: noUncheckedIndexedAccess: true

# Formatter is now ENABLED (was disabled at the §1.2 baseline) + real gate
grep -n '"formatter"' biome.json         # formatter.enabled: true; schema pinned 2.4.16
node -e "console.log(require('./package.json').scripts['format:check'])"  # => "biome format ."
node -e "console.log(require('./package.json').scripts.quality)"          # now CHAINS format:check

# Milestone tree is green
npm run build                            # exit 0 (tsc && tsc -p packages/wft-router && build:skills)

# Agent-context manifest refreshed to reflect the milestone's doc edits
npm run agent-context:gen                # Wrote .agent-context.json (28 files, 10 groups)
npm run agent-context:check              # agent-context:check OK. (was: out of date)
```

### §777.B — Before→after scorecard (milestone movement)

"Before" = the §1 baseline at `a872170` (audit start, 2026-06-05). "After" =
this commit `7c1b051` (2026-06-06, all project-37 tasks landed).

| Dimension | Before (baseline `a872170`) | After (`7c1b051`) | Moved by |
| --- | --- | --- | --- |
| `noPropertyAccessFromIndexSignature` | **OFF** (deferred) | **ON** | #763 |
| `exactOptionalPropertyTypes` | **OFF** (deferred) | **ON** | #778→#779→#780 |
| `noUncheckedIndexedAccess` | **OFF** (deferred) | **ON** | #781→#782→#783→#784 |
| Biome formatter | `enabled:false`, **no gate**, `format:check` hard-`exit 1` | `enabled:true`, **`format:check` = `biome format .`**, CI gate live | formatter-enable sweep (landed; see §777.C) |
| `npm run quality` chain | build·test·lint·lint:deps·depcruise·audit | **+ `format:check`** inserted after lint | formatter-enable |
| biome `$schema` drift | 2.4.15 vs installed 2.4.16 (1 info diag) | **2.4.16** — resolved, lint clean 0 info | schema bump |
| API/CLI response Zod validation | routes-in only; list/task/project responses cast | **responses validated** through schemas | #774 |
| Advisory complexity report | none | **`npm run quality:complexity`** + CI `complexity` job (advisory) + calibrated outlier inventory | #771 |
| Benchmark / perf policy | benches exist, no policy doc | **`docs/BENCHMARK_POLICY.md`** (hot-path, baseline, advisory-vs-block rule) | #773 |
| Mutation-survivor coverage | 75% break gate only | **+ cascade-depth survivor tests** + "when to request a run" policy | #772 |
| Escape-hatch budget | none | **CI-gated ratchet** (`scripts/quality/escape-hatch-budget.mjs`) + policy | #766 (prior wave, confirmed live) |
| Agent-context manifest | stale (line/sha drift) | **regenerated, check green** | #777 (this task) |

**Scorecard areas (§3) re-scored after the milestone:**

| # | Area | Before | After | Why it moved |
| --- | --- | :---: | :---: | --- |
| 1 | Compiler strictness | 3.5 | **5** | all three deferred strict flags ON (#763/#780/#784) |
| 2 | Formatting | 1.5 | **4.5** | formatter enabled + `format:check` is a live CI gate + schema drift gone |
| 3 | Lint | 2.5 | **3** | schema-drift info cleared; rule set still minimal-by-design (async-safety still a follow-up) |
| 4 | Async safety | 2 | **2** | UNCHANGED — no-floating-promises lint still absent (recommended follow-up F1) |
| 5 | Runtime boundary validation | 3.5 | **4** | API/CLI response validation closed (#774); MCP/Slack casts still budgeted |
| 6 | Testing / coverage | 4.5 | 4.5 | already strong; #772 added targeted survivor tests |
| 7 | Mutation testing | 4.5 | 4.5 | #772 added survivor tests + run policy; gate unchanged |
| 8 | Dependency boundaries | 5 | 5 | unchanged (already maxed) |
| 9 | CI / release | 4.5 | **5** | format-check + escape-hatch budget now gating; complexity advisory job added |
| 10 | Docs | 4 | **4.5** | this audit + roadmap + BENCHMARK_POLICY + complexity calibration |

**Net:** the milestone closed the entire strict-flag ratchet (area 1 → 5),
turned formatting from the worst area into a live gate (area 2 → 4.5), and
hardened the response boundary (area 5). The single remaining sub-3 area is
**async safety** (area 4) — the highest-charter-weight residual gap and the
top recommended follow-up below.

### §777.C — Landed gates are reflected in CI / PR template / docs (verified)

Checked each landed gate against the three surfaces; refs are file:line at
`7c1b051`.

**CI — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):**

| Gate | Reflected in CI | Ref |
| --- | --- | --- |
| Build (tsc, incl. router + skills, under all 3 strict flags) | `build` job | `ci.yml:90-101` |
| Lint (biome) | `lint` job step | `ci.yml:83-84` |
| **Format check** (`biome format .`) | `lint` job step — **NOW LIVE** | `ci.yml:85-86` |
| **Escape-hatch budget** ratchet | `lint` job step | `ci.yml:87-88` |
| Coverage thresholds | `coverage` job | `ci.yml:34-45` |
| Import boundaries / cycles | `depcruise` job | `ci.yml:60-71` |
| Unused-dep drift | `deps` job | `ci.yml:47-58` |
| Prod audit | `audit` job | `ci.yml:103-114` |
| **Complexity report** (advisory) | `complexity` job, `continue-on-error: true` | `ci.yml:116-134` |
| Agent-context manifest/links/budget | `agent-context` job | `ci.yml:136-147` |
| Vendor-neutrality | `vendor-neutrality` job | `ci.yml:149-160` |
| Router pack / OCI / host-manifests | `pack-smoke` / `oci-build` / `host-manifests` | `ci.yml:162-265` |

Mutation (`mutation.yml`) and benchmark (`bench.yml`) stay on their own
nightly/label/dispatch workflows by design (expensive; §1.5, BENCHMARK_POLICY).

**Doc-staleness fixed by this review (CI/format reflection):** §1.2, §1.9,
§3 (area 2), §4.1, and the §2 comparison row all asserted the formatter was
**disabled / not a CI gate** and that the schema was drifted at 2.4.15. Both are
now false — see §777.F for the inline corrections applied.

**PR template — [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md):**
The "Quality" section already prompts affected layers, runtime boundaries, test
level, the `npm run quality` composite, and security-sensitive surfaces
(`PULL_REQUEST_TEMPLATE.md:29-37`). `npm run quality` now transitively runs
`format:check` + the escape-hatch budget, so those gates ARE covered by the
existing checkbox. This review **adds one strictness-flag bullet** to the
Quality section so contributors explicitly account for the now-active
`exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` conventions
(omit-undefined, guard-and-bind) when adding optional-field / indexed-access
code — see §777.F.

**Roadmap — [`docs/CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md):** the
"Deferred flags", Phase-6 formatter-deferred status, and "Definition Of Done"
strict-flag/format lines were stale (all three flags + the formatter are now
DONE). Corrected in §777.F.

### §777.D — Obsolete roadmap statements marked complete

The strictness ratchets and the formatter enable are **no longer planned** — they
landed. This review updates `docs/CODE_QUALITY_ROADMAP.md` to mark them DONE
(Phase 2 "Deferred flags", Phase 6 formatter status, the "Definition Of Done"
strict-flag + format bullets, and "Remaining open items"). The full edits are
itemized in §777.F.

### §777.E — Recommended follow-up tasks (for a human to promote)

These are **proposed tasks**, NOT created here (no task API was called). Each has
enough detail to become a task directly.

1. **F1 — Async-safety lint (no-floating-promises / no-unhandled-promise).**
   *Charter: Defect prevention (13) — highest residual.* Biome is not
   type-aware, so this needs a typescript-eslint layer (or equivalent) scoped to
   floating/misused promises only, ratcheted warning-free. This is the only
   sub-3 scorecard area left (§777.B area 4) and the single highest-value gap.
   Note a partial guard already exists from the prior milestone (commit `8a81d83`
   "Biome type-aware floating/misused-promise lint gate") — F1 should **verify
   coverage/escape gaps** of that gate rather than assume none exists.

2. **F2 — Retire the 4 pre-existing blanket bracket-index `!` escape hatches.**
   *Charter: Defect prevention (13).* Surfaced by the #784 flag-flip but invisible
   to the #781 probe (the `!` suppressed the error). Replace each with
   guard-and-bind / empty-state per §D approved patterns:
   - `src/slack/formatters/project-formatter.ts:45` — `projects[i]!` (index-loop body)
   - `src/slack/notifier.ts:99` — `results[i]!` (index-loop body)
   - `src/slack/commands/tasks-command.ts:109` — `args[i]!` (arg-parse loop)
   - `src/events/sse-manager.ts:203` — `this.eventBuffer[0]!.id` (first-element after `length>0`)
   `slack/` and `events/sse-manager` were out of the #782/#783 scope, so this
   brings the no-blanket-`!` rule to 100% across the index-access surface. Not
   regressions — they pre-date the audit. (Full table in §784.)

3. **F3 — Re-scope the vendor-neutrality exemption marker in
   `packages/wft-router/src/sse/client.ts`.** *Charter: Boundary integrity (8).*
   The `WFT-NEUTRALITY-EXEMPT-LINE` marker is mis-scoped around the `cursor_gap`
   SSE log: it is sprinkled across the *comment* lines (`:20-21,405-406,433-434`)
   and the `logger.warn('cursor_gap', {` block (`:436-437`) more broadly than the
   single line that genuinely needs the exemption. Tighten the marker to the exact
   line(s) the `check:vendor-neutrality` gate would otherwise flag, so the
   exemption surface is minimal and auditable. Confirm green with
   `npm run check:vendor-neutrality`. (Cited at `client.ts:436` in the #777
   discovery comment.)

4. **F4 — Agent-context manifest freshness — ADDRESSED here, keep watching.**
   *Charter: Maintainability (2).* The `.agent-context.json` manifest was stale
   (line-count + sha256 drift from the milestone's doc edits to
   `CODE_QUALITY_ROADMAP.md` et al.). This review ran `npm run agent-context:gen`
   and `agent-context:check` now passes (§777.A). NOTE the generator tracks a
   fixed doc set (28 files / 10 groups) and does **not** auto-add new docs like
   `BENCHMARK_POLICY.md` / `TYPESCRIPT_QUALITY_AUDIT_2026.md` as standalone
   entries — if those should be first-class manifest entries, that is a separate
   config change to `scripts/agent-context/` (proposed follow-up, low priority).

5. **F5 (optional) — Lint-posture decision above `recommended:false`.**
   *Charter: Defect prevention (13) / velocity (5).* The repo runs a deliberately
   minimal 2-rule Biome set. Decide explicitly whether to stay minimal-by-design
   or adopt a curated subset above `recommended:false` (pairs naturally with F1).
   Cheap; clarifies intent. (Was roadmap P4.)

### §777.F — Edits applied by this review

Doc + manifest only (no source/behaviour changes):

- **`.agent-context.json`** — regenerated via `npm run agent-context:gen`;
  `agent-context:check` now exits 0 (was: out of date). Diff is line-count/sha256
  refresh for the milestone-edited docs + the generator's canonical array reflow;
  no doc-set membership change.
- **`docs/CODE_QUALITY_ROADMAP.md`** — marked the three strict flags and the
  formatter DONE (Phase 2 "Deferred flags", Phase 6 status, "Definition Of Done",
  "Remaining open items"); updated the stale "no formatter / no build in CI /
  101 files·1300 tests" facts to point at this milestone.
- **`docs/TYPESCRIPT_QUALITY_AUDIT_2026.md`** — this §777 section; plus inline
  corrections to §1.2 / §1.9 / §2 / §3-area-2 / §4.1 noting the formatter is now
  enabled + gated and the biome schema drift is resolved.
- **`.github/PULL_REQUEST_TEMPLATE.md`** — added one strictness-conventions bullet
  to the "Quality" section.

### §777.G — Self-attestation (#777)

No secret, token, password, API key, or absolute local path was introduced. No
task API was called and no tasks were created — §777.E is a planning list only.
`npm run build` exits 0 at this commit. `npm run agent-context:check` exits 0
after the regen. Source code was not modified (the 4 `!` sites, the
vendor-neutrality marker, and the async-safety gap are documented follow-ups
F1–F3, not fixed here per the task's "document, don't fix" scope).
