# Quality Commands

> Owner: maintainers
>
> A practical guide to the local quality commands for contributors and
> agents: which one to run while iterating, which one mirrors CI before you
> open a PR, what each step needs (network/runtime), and how to triage a
> failure. For the deeper *why* behind each gate, see
> [`CONTRIBUTING.md`](../CONTRIBUTING.md) (Quality Gates section) and
> [`docs/TYPESCRIPT_QUALITY_AUDIT_2026.md`](./TYPESCRIPT_QUALITY_AUDIT_2026.md).

## TL;DR — which command do I run?

| Situation | Command | Network? | Rough runtime |
| --------- | ------- | -------- | ------------- |
| Iterating locally, want a fast all-green signal | `npm run quality:fast` | **No** | minutes (build + full test suite dominate) |
| About to open a PR / want the CI-equivalent gate | `npm run quality:full` (alias of `npm run quality`) | **Yes** (`npm audit`) | minutes + audit round-trip |
| Composite gate (unchanged, historical name) | `npm run quality` | **Yes** | same as `quality:full` |

`quality:full` is a thin alias for `quality` — they run the exact same gate
set. Use whichever name reads better in your workflow; `quality:full` exists
to pair naturally with `quality:fast`.

## What each command runs

### `npm run quality:fast` — quick local check (no network)

```
npm run build && npm test && npm run lint && npm run lint:deps && npm run depcruise
```

This is `quality` **minus the network `npm audit` step**. Use it while
iterating: it exercises every offline gate (type-check/build, tests with
coverage thresholds, lint, dependency hygiene, import-boundary checks) but
never reaches the network, so it works on a plane, in a sandbox, or behind a
flaky proxy. It is *not* a substitute for the full CI gate before merge —
it deliberately omits the dependency-audit advisory check.

### `npm run quality:full` — full CI-equivalent check

```
npm run quality
```

Alias of the composite `quality` gate (below). This is what you should run
before opening a PR — it mirrors the gates CI enforces on every PR.

### `npm run quality` — composite gate (unchanged)

```
npm run build && npm test && npm run lint && npm run lint:deps && npm run depcruise && npm audit --omit=dev --audit-level=high
```

The long-standing composite gate. **Its definition is unchanged** by the
addition of the `quality:fast` / `quality:full` aliases — it remains at
least as strict as it has always been. The only step that needs the network
is the final `npm audit`.

## Per-step breakdown

| Step | Command | Needs network? | Notes |
| ---- | ------- | -------------- | ----- |
| Build / type-check | `npm run build` | No | `tsc` for the root + `packages/wft-router`, then builds skills. A type error here fails everything downstream. |
| Tests | `npm test` | No | `vitest run`. Enforces coverage thresholds from `vitest.config.ts` (lines/functions/statements 85%, branches 75%). |
| Lint | `npm run lint` | No | `biome check .`. **Formatter is intentionally disabled** — `format:check` is *not* a gate today (see below). |
| Dependency hygiene | `npm run lint:deps` | No | `knip --dependencies` — flags unused / missing dependencies. |
| Import boundaries | `npm run depcruise` | No | `dependency-cruiser` — enforces no import cycles and layer boundaries per `.dependency-cruiser.cjs`. |
| Production audit | `npm audit --omit=dev --audit-level=high` | **Yes** | Production dependencies only, high+ severity. The single network step; excluded from `quality:fast`. |

> Note on `format:check`: Biome's formatter is disabled
> (`biome.json` → `formatter.enabled=false`), so `format:check` is a
> deliberate non-gate and is **not** part of any quality command. Running
> `npm run format:check` today fails on purpose with an explanatory message
> so the missing gate cannot masquerade as green. A dedicated follow-up PR
> will enable the formatter and re-add the gate.

## Failure triage

When a quality command fails, find the failing step in the output and jump
to the matching row. Each step is independent — fix the first failure, then
re-run.

| Failure class | Symptom in output | Where to look / how to fix |
| ------------- | ----------------- | -------------------------- |
| **Build / type error** | `tsc` errors, "Cannot find module", type mismatches; failure before any test runs | Fix the reported TypeScript error at the cited file:line. For layering/structure questions see [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). General build/runtime gotchas: [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). |
| **Test (vitest) failure** | `vitest` reports failed assertions, or a coverage threshold like "ERROR: Coverage for lines (…) does not meet threshold" | Run `npm run test:watch` to iterate on the failing file, or `npm run test:coverage` to see the coverage gap. Test policy, where tests live, and coverage thresholds are in [`CONTRIBUTING.md`](../CONTRIBUTING.md) (Testing section). Flaky/environment issues: [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). |
| **Lint (biome) failure** | `biome check` reports lint diagnostics with rule names | Read the rule name and the cited file:line and fix the code. Do **not** reach for `format:check` — formatting is not a gate. Biome config is `biome.json`. |
| **Dependency hygiene (`lint:deps`)** | `knip` lists unused or unlisted dependencies | Remove the unused dependency from `package.json`, or add the missing one. If the report is a false positive, configure `knip` rather than disabling the gate. |
| **Import boundary (`depcruise`)** | `dependency-cruiser` prints a rule name (e.g. `no-circular`, `leaves-no-upstream`, `services-layer`) and the offending import path | Open [`.dependency-cruiser.cjs`](../.dependency-cruiser.cjs); each rule's `comment` field explains the policy in plain English. Usually the fix is to move the import to the correct layer (e.g. import a shared type from `src/types/`). The `no-circular` rule is **not** downgradable — cycles must be broken. Full boundary policy: [`CONTRIBUTING.md`](../CONTRIBUTING.md) (Architecture and Boundary Checks) and [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md). |
| **Audit advisory (`npm audit`)** | `npm audit` reports a high/critical advisory in a **production** dependency | Bump the affected production dependency to a patched version (or add an `overrides` entry in `package.json` if a transitive dep is the culprit, as already done for `qs`). CI gates production deps only via `--omit=dev --audit-level=high`; **dev-dependency advisories are advisory, not gated** — review them but they do not block. This is the only step that needs the network, so a *network* failure here (not an advisory) means you are offline — use `quality:fast` to keep iterating and re-run the full gate when connected. See [`CONTRIBUTING.md`](../CONTRIBUTING.md) (Dependency audit policy). |

## Relationship to CI

CI runs the same offline gates plus the production audit on every PR — i.e.
the `quality` / `quality:full` set. Running `quality:full` locally before
opening a PR is the closest you can get to the CI verdict on your own
machine. `quality:fast` is the fast inner-loop equivalent that trades the
network audit for speed and offline reliability.
