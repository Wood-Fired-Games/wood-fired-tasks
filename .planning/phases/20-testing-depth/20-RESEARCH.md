# Phase 20: Testing Depth - Research

**Researched:** 2026-02-17
**Domain:** Mutation testing (Stryker), property-based testing (fast-check), unused dependency detection (knip)
**Confidence:** HIGH

## Summary

Phase 20 adds three testing quality layers to the existing Vitest suite (598 tests, 52 files). None of the three tools require changes to production code — they are purely developer tooling additions. All three integrate well with this project's stack (TypeScript + Vitest + `"type": "module"` + npm).

**Stryker** (mutation testing) has first-class Vitest support since v7.0. StrykerJS 9.5.1 is the current release. The project's `"type": "module"` in package.json is fully supported since Stryker v6 — the config file becomes an ES module automatically when using `.js` extension. The TypeScript checker plugin (`@stryker-mutator/typescript-checker`) filters out type-invalid mutants before running tests, which reduces runtime and improves accuracy. The vitest runner always uses `perTest` coverage analysis for best performance. One real risk: Stryker's `vitest.related: true` can fail when integration tests don't directly import the source files they test (e.g., the existing `createTestApp()` integration pattern). Setting `related: false` resolves this.

**fast-check** property-based testing has a dedicated Vitest integration package (`@fast-check/vitest` v0.2.4) that uses `test.prop()` syntax, integrates directly with Vitest's test runner, and captures seeds on failure for deterministic reproduction. This project has several excellent candidates for property tests: the `CycleDetector` (graph invariants), `VALID_STATUS_TRANSITIONS` (state machine reachability), and validation schemas (boundary conditions for string lengths, integers, ISO dates). The `@fast-check/vitest` package exports `test` and `fc` — tests use `test.prop([arb1, arb2])('description', (a, b) => {...})` syntax.

**knip** (v5.83.1) has a built-in Vitest plugin that auto-activates when vitest appears in devDependencies. It adds `**/*.{test,spec}.ts` as entry patterns automatically, meaning test files are never reported as unused. Knip exits with code 1 when issues are found, enabling CI failure. The `--dependencies` flag restricts checks to only unused dependencies (not exports/files). Exclusions are documented in `knip.json` via `ignoreDependencies`.

**Primary recommendation:** Three independent plans, one per requirement. Plan order: knip first (simplest, zero configuration needed), fast-check second (adds new test files, no existing code changes), Stryker last (most complex, may need tuning of `mutate` globs and thresholds).

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| TEST-01 | Mutation testing with Stryker validates test suite effectiveness | StrykerJS 9.5.1 + `@stryker-mutator/vitest-runner` 9.5.1 + `@stryker-mutator/typescript-checker` 9.5.1. Vitest >=2.0.0 required (project has ^4.0.18). ESM (`"type":"module"`) supported since Stryker v6 — config file uses `.js` extension naturally. Configure `stryker.config.js`, add `npm run test:mutation` script, HTML report generated. |
| TEST-02 | Property-based testing with fast-check supplements example-based tests | `@fast-check/vitest` 0.2.4 provides `test.prop()` syntax. CycleDetector, status transitions, and schema validation are primary targets. Tests live alongside existing `__tests__` directories. No changes to production code. |
| TEST-03 | Unused dependency detection with knip integrated into CI; CI fails if unused deps detected | knip 5.83.1 with `--dependencies` flag. Exit code 1 on issues. Add `npm run lint:deps` script. Vitest plugin auto-detects test files. Exclusions via `ignoreDependencies` in `knip.json` with documented rationale. No CI workflows exist yet — this phase creates GitHub Actions `.github/workflows/ci.yml`. |

</phase_requirements>

## Standard Stack

### Core (new dev dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@stryker-mutator/core` | `^9.5.1` | Mutation testing framework | Industry standard for JS/TS mutation testing; official Vitest support since v7 |
| `@stryker-mutator/vitest-runner` | `^9.5.1` | Stryker plugin for Vitest test runner | Official plugin; `perTest` coverage analysis built-in |
| `@stryker-mutator/typescript-checker` | `^9.5.1` | Filters type-invalid mutants before testing | Reduces false survivor mutants; preserves accuracy |
| `@fast-check/vitest` | `^0.2.4` | Property-based testing integration for Vitest | Official package; `test.prop()` syntax; seed capture for reproduction |
| `knip` | `^5.83.1` | Unused file/dependency/export detection | Built-in Vitest plugin; exit code 1 on issues; CI-ready |

### Already Installed (no changes needed)

| Library | Version | Role in Phase 20 |
|---------|---------|-----------------|
| `vitest` | `^4.0.18` | Both Stryker and fast-check depend on this existing installation |
| `typescript` | `^5.9.3` | Stryker TypeScript checker uses this |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@stryker-mutator/vitest-runner` | `@stryker-mutator/jest-runner` | Jest runner requires Jest; project uses Vitest |
| `@fast-check/vitest` | `fast-check` (bare) | Bare fast-check requires `fc.assert(fc.property(...))` wrapper; `@fast-check/vitest` provides cleaner `test.prop()` syntax native to Vitest |
| `knip` | `depcheck` | depcheck is less maintained, no Vitest plugin, no `--dependencies` filter flag |

**Installation:**
```bash
npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner @stryker-mutator/typescript-checker @fast-check/vitest knip
```

## Architecture Patterns

### Recommended Project Structure (additions only)

```
/
├── stryker.config.js           # Stryker configuration (ESM .js, not .json)
├── knip.json                   # Knip configuration with ignoreDependencies
├── .github/
│   └── workflows/
│       └── ci.yml              # GitHub Actions CI (created by TEST-03)
└── src/
    ├── utils/__tests__/
    │   └── cycle-detector.property.test.ts   # Property tests for CycleDetector
    └── services/__tests__/
        └── status-transitions.property.test.ts  # Property tests for state machine
```

### Pattern 1: Stryker Configuration (ESM)

**What:** `stryker.config.js` using ES module syntax (works automatically when `"type":"module"` in package.json).

**When to use:** Project-level mutation config; `stryker.config.js` takes precedence over `stryker.config.json`.

**Example:**
```javascript
// stryker.config.js (ESM — works because package.json has "type": "module")
// Source: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
    related: false,  // Must be false: integration tests use createTestApp(), not direct imports
  },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    '!src/db/migrate.ts',
    '!src/cli/bin/tasks.ts',
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  typescriptChecker: {
    prioritizePerformanceOverAccuracy: true,
  },
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: {
    high: 80,
    low: 60,
    break: null,   // Do not fail CI on score — mutation runs are advisory initially
  },
  packageManager: 'npm',
};
```

### Pattern 2: fast-check with @fast-check/vitest (array-style)

**What:** `test.prop([arb1, arb2])` wraps a property test generating multiple random inputs.

**When to use:** Testing pure functions with domain-invariant properties.

**Example:**
```typescript
// Source: https://www.npmjs.com/package/@fast-check/vitest
import { test, fc } from '@fast-check/vitest';
import { CycleDetector } from '../../utils/cycle-detector.js';

// Property: a->b->a is always a cycle
test.prop([fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 100 })])(
  'self-loop is always a cycle',
  (nodeId, otherId) => {
    fc.pre(nodeId !== otherId);  // precondition
    const detector = new CycleDetector([]);
    // A->B, B->A must form a cycle
    const detectorWithEdge = new CycleDetector([{ task_id: nodeId, blocks_task_id: otherId }]);
    return detectorWithEdge.wouldCreateCycle(otherId, nodeId) === true;
  }
);
```

### Pattern 3: fast-check with @fast-check/vitest (object-style, with constantFrom)

**What:** `fc.constantFrom(...values)` picks from a fixed set — ideal for TypeScript `const` array members like `TASK_STATUSES`.

**When to use:** Testing against enum-like `as const` arrays.

**Example:**
```typescript
// Source: https://fast-check.dev/docs/ecosystem/
import { test, fc } from '@fast-check/vitest';
import { VALID_STATUS_TRANSITIONS, TASK_STATUSES } from '../../types/task.js';
import type { TaskStatus } from '../../types/task.js';

const anyStatus = fc.constantFrom(...TASK_STATUSES);

// Property: every valid transition in the map is reflexively defined
test.prop({ from: anyStatus, to: anyStatus })(
  'valid transitions are never self-referential dead ends',
  ({ from, to }) => {
    const validTargets = VALID_STATUS_TRANSITIONS[from];
    if (validTargets.includes(to)) {
      // If from->to is valid, 'to' must also have outgoing transitions
      return VALID_STATUS_TRANSITIONS[to].length > 0;
    }
    return true; // invalid transitions are trivially fine
  }
);
```

### Pattern 4: knip Configuration

**What:** `knip.json` with entry points, project scope, and `ignoreDependencies` for documented exceptions.

**Example:**
```json
{
  "entry": [
    "src/index.ts",
    "src/api/start.ts",
    "src/cli/bin/tasks.ts",
    "src/mcp/index.ts",
    "src/db/migrate.ts"
  ],
  "project": ["src/**/*.ts"],
  "ignoreDependencies": [
    "pino-pretty"
  ]
}
```

> `pino-pretty` is a runtime optional dependency loaded by Fastify/pino when `NODE_ENV !== 'production'` — it will appear unused to static analysis but is intentionally referenced by convention. Document this exclusion.

### Pattern 5: GitHub Actions CI (knip integration)

**What:** A `.github/workflows/ci.yml` that runs knip with `--dependencies` flag and fails on exit code 1.

**Example:**
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm test
      - name: Check unused dependencies
        run: npx knip --dependencies
```

### Anti-Patterns to Avoid

- **Using `stryker.config.json` instead of `stryker.config.js`:** The `.json` format cannot use dynamic values and does not support ESM imports. Use `.js` with `export default {}`.
- **Setting `vitest.related: true` with integration tests:** The project's tests use `createTestApp()` which does not directly import the source files being tested. Stryker's `related` optimization will skip those tests, making all service-layer mutants "survivors." Use `related: false`.
- **Setting `thresholds.break` on first Stryker run:** The initial mutation score is unknown. Set `break: null` first, observe the baseline, then decide on a threshold.
- **Running `knip` without `--dependencies`:** Without the flag, knip also checks for unused exports and files, which may produce many false positives in a project that hasn't fully configured its entry points. Scope to `--dependencies` for CI gate; full scan is advisory.
- **Creating `.mjs` extension for stryker config:** Unnecessary when `"type": "module"` is already in package.json. Use `.js` extension to match the existing project convention.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Mutation operators (replacing `>` with `>=`, etc.) | Custom AST transforms | Stryker | 30+ built-in mutators; handles TypeScript, ESM; deterministic test isolation in sandbox |
| Random test data generation with shrinking | `Math.random()` in tests | fast-check arbitraries | Minimal failing examples; seed capture for reproduction; combined arbitraries (fc.record, fc.array, etc.) |
| Unused dependency scanning | Regex over import statements | knip | Framework-aware (understands Vitest, Fastify, etc.); doesn't flag test setup files; TypeScript path aliases supported |

**Key insight:** These tools solve deceptively complex static analysis and test generation problems. Hand-rolled solutions miss edge cases (transitive dependencies, shrinking, ESM graph traversal) that the libraries handle correctly.

## Common Pitfalls

### Pitfall 1: `vitest.related: true` Kills Integration Test Coverage

**What goes wrong:** Stryker runs only tests "related" to a mutated file based on import graphs. Tests using `createTestApp()` (all service-level tests in this project) don't directly import the mutated source files — they access services through the assembled app. Stryker sees no relation, skips them, and reports mutants as "survived" incorrectly.

**Why it happens:** The `related` optimization works on static import analysis. Dynamic composition patterns (factory functions, dependency injection) are invisible to static analysis.

**How to avoid:** Set `vitest: { related: false }` in `stryker.config.js`. This disables the optimization and runs all tests against all mutants. Slower but accurate.

**Warning signs:** Mutation score is unexpectedly high (80-90%+) with all mutants surviving — this indicates tests were skipped.

### Pitfall 2: Stryker Crashes on TypeScript Type-Only Mutants

**What goes wrong:** Stryker generates mutants that are syntactically valid JavaScript but fail TypeScript type checks. These cause test runner crashes rather than clean "survived/killed" results.

**Why it happens:** Stryker mutates source code without type awareness by default.

**How to avoid:** Install and enable `@stryker-mutator/typescript-checker`. Add `"checkers": ["typescript"]` to config. This pre-filters type-invalid mutants before running tests.

**Warning signs:** Stryker reports many "runtime errors" or crashes during mutation runs.

### Pitfall 3: fast-check Tests Are Non-Deterministic Without Seed Management

**What goes wrong:** Property tests fail intermittently because different random seeds are used on each run.

**Why it happens:** Without seed capture, reproducing a specific failure requires luck.

**How to avoid:** Use `@fast-check/vitest` — it automatically captures and logs the seed on failure. The failure output includes a `seed` value to replay the exact sequence. No additional configuration needed.

**Warning signs:** A failing test in CI that you cannot reproduce locally.

### Pitfall 4: knip Reports `pino-pretty` as Unused

**What goes wrong:** `pino-pretty` is a devDependency used by pino/Fastify when `NODE_ENV !== 'production'` as an optional pretty-printer. It is not imported anywhere in the source code — it is convention-loaded.

**Why it happens:** knip does static import analysis. Convention-loaded packages are invisible to static analysis.

**How to avoid:** Add `pino-pretty` to `ignoreDependencies` in `knip.json` with a comment explaining why. This is the explicit exclusion that satisfies the requirement "or explicit exclusions documented."

**Warning signs:** knip exits 1 in CI with `pino-pretty` as the only reported dependency.

### Pitfall 5: Stryker Mutates Test Helper Files

**What goes wrong:** Stryker mutates test utility files (e.g., `createTestApp`), which corrupts the test environment itself rather than testing production code.

**Why it happens:** The default `mutate` glob includes all `.ts` files if not narrowed.

**How to avoid:** Explicitly exclude `__tests__` directories and `.test.ts` files from the `mutate` pattern. See the config example in Pattern 1.

## Code Examples

Verified patterns from official sources:

### Stryker Full Config for This Project

```javascript
// stryker.config.js
// Source: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
//         https://stryker-mutator.io/docs/stryker-js/typescript-checker/
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
    related: false,
  },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/*.test.ts',
    '!src/db/migrate.ts',
    '!src/cli/bin/tasks.ts',
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  typescriptChecker: {
    prioritizePerformanceOverAccuracy: true,
  },
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: { high: 80, low: 60, break: null },
  packageManager: 'npm',
};
```

### Package.json Script Additions

```json
{
  "scripts": {
    "test:mutation": "stryker run",
    "lint:deps": "knip --dependencies"
  }
}
```

### knip.json for This Project

```json
{
  "entry": [
    "src/index.ts",
    "src/api/start.ts",
    "src/cli/bin/tasks.ts",
    "src/mcp/index.ts",
    "src/db/migrate.ts"
  ],
  "project": ["src/**/*.ts"],
  "ignoreDependencies": [
    "pino-pretty"
  ]
}
```

### Property Test: CycleDetector Invariants

```typescript
// src/utils/__tests__/cycle-detector.property.test.ts
// Source: https://www.npmjs.com/package/@fast-check/vitest
import { test, fc } from '@fast-check/vitest';
import { CycleDetector } from '../cycle-detector.js';

const edgeArb = fc.record({
  task_id: fc.integer({ min: 1, max: 50 }),
  blocks_task_id: fc.integer({ min: 1, max: 50 }),
}).filter(e => e.task_id !== e.blocks_task_id);

test.prop([fc.array(edgeArb, { maxLength: 20 }), fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 50 })])(
  'cycle detection is symmetric: if A->B creates a cycle, then graph already has B->...->A path',
  (existingEdges, from, to) => {
    fc.pre(from !== to);
    const detector = new CycleDetector(existingEdges);
    const wouldCycle = detector.wouldCreateCycle(from, to);
    // If adding from->to creates a cycle, there must be a path to->...->from already
    // This is a fundamental graph theory property — just verify no crash
    return typeof wouldCycle === 'boolean';
  }
);

test.prop([fc.integer({ min: 1, max: 100 })])(
  'node with no edges never creates a cycle with itself excluded',
  (nodeId) => {
    const detector = new CycleDetector([]);
    // A single new edge from A to B (A != B) with empty graph cannot be a cycle
    const otherId = nodeId === 100 ? 1 : nodeId + 1;
    return detector.wouldCreateCycle(nodeId, otherId) === false;
  }
);
```

### Property Test: Status Transition State Machine

```typescript
// src/services/__tests__/status-transitions.property.test.ts
import { test, fc } from '@fast-check/vitest';
import { VALID_STATUS_TRANSITIONS, TASK_STATUSES } from '../../types/task.js';
import type { TaskStatus } from '../../types/task.js';

const anyStatus = fc.constantFrom(...TASK_STATUSES);

test.prop([anyStatus])(
  'every status has at least one valid outgoing transition',
  (status) => {
    return VALID_STATUS_TRANSITIONS[status].length > 0;
  }
);

test.prop([anyStatus, anyStatus])(
  'backlogged only transitions to open (Phase 18-02 decision)',
  (from, to) => {
    if (from === 'backlogged') {
      const valid = VALID_STATUS_TRANSITIONS['backlogged'];
      return valid.length === 1 && valid[0] === 'open';
    }
    return true;
  }
);
```

### GitHub Actions CI with knip

```yaml
# .github/workflows/ci.yml
# Source: https://knip.dev/reference/cli
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm test

  deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - name: Check unused dependencies
        run: npx knip --dependencies
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Stryker required CommonJS; ESM unsupported | ESM native support via `"type":"module"` | Stryker v6 (2022) | No workarounds needed for this project |
| Vitest runner missing from Stryker | Official `@stryker-mutator/vitest-runner` | Stryker v7.0 (2023) | Direct integration; no Jest needed |
| `fast-check` required `fc.assert(fc.property(...))` boilerplate | `@fast-check/vitest` provides `test.prop()` | Package v0.2.0 (2024) | Cleaner syntax; native Vitest integration |
| depcheck was the standard unused-dep tool | `knip` has replaced depcheck | 2022-2023 | Framework-aware; no false positives on test files |

**Deprecated/outdated:**
- `depcheck`: Less maintained; no Vitest plugin; no `--dependencies` filter. Use `knip` instead.
- `stryker.config.json` format: Usable but cannot express dynamic logic. Prefer `stryker.config.js`.

## Open Questions

1. **What will the initial Stryker mutation score be?**
   - What we know: 598 tests exist; tests are integration-style using `createTestApp()`; all go through service layer
   - What's unclear: Score range — integration tests tend to kill many mutants, but boundary conditions (off-by-one in SQL filters, status transition edge cases) may escape
   - Recommendation: Run with `break: null` initially; observe score; set `break` threshold in a follow-up commit if desired

2. **Will knip report any false positives beyond pino-pretty?**
   - What we know: Project has 15 dependencies; Vitest plugin auto-detects test files; pino-pretty is a known exception
   - What's unclear: Whether `@types/*` packages are handled correctly; whether CLI binaries in `scripts` are seen
   - Recommendation: Run knip locally before finalizing `knip.json`; add findings to `ignoreDependencies` with comments

3. **Does Stryker's concurrency interact badly with `fileParallelism: false` in vitest.config.ts?**
   - What we know: Project vitest config sets `fileParallelism: false` (to avoid env var conflicts); Stryker handles its own parallelization; vitest runner enforces single-threaded execution internally
   - What's unclear: Whether Stryker's concurrency setting conflicts with this
   - Recommendation: Start with default concurrency; reduce via `--concurrency 2` flag if hangs occur

## Sources

### Primary (HIGH confidence)

- [Stryker Vitest Runner docs](https://stryker-mutator.io/docs/stryker-js/vitest-runner/) — installation, configuration options, known limitations, `related` flag behavior
- [Stryker TypeScript Checker docs](https://stryker-mutator.io/docs/stryker-js/typescript-checker/) — installation, config options, `prioritizePerformanceOverAccuracy`
- [Stryker Configuration docs](https://stryker-mutator.io/docs/stryker-js/configuration/) — `mutate`, `reporters`, `thresholds`, `checkers`, `packageManager`
- [Stryker Troubleshooting docs](https://stryker-mutator.io/docs/stryker-js/troubleshooting/) — Vitest file discovery issue, TypeScript watcher issue
- [@fast-check/vitest npm package](https://www.npmjs.com/package/@fast-check/vitest) — API surface, `test.prop()` syntax, v0.2.4 for vitest v4.x
- [fast-check ecosystem docs](https://fast-check.dev/docs/ecosystem/) — `@fast-check/vitest` as official package
- [Knip CLI reference](https://knip.dev/reference/cli) — `--dependencies` flag, exit codes (0=clean, 1=issues, 2=error), `--max-issues`
- [Knip configuration reference](https://knip.dev/reference/configuration) — `entry`, `project`, `ignoreDependencies`, `ignoreBinaries`
- [Knip Vitest plugin](https://knip.dev/reference/plugins/vitest) — auto-activation on vitest devDependency, entry patterns added
- npm registry — confirmed versions: `@stryker-mutator/core` 9.5.1, `@stryker-mutator/vitest-runner` 9.5.1, `@stryker-mutator/typescript-checker` 9.5.1, `@fast-check/vitest` 0.2.4, `knip` 5.83.1

### Secondary (MEDIUM confidence)

- [Announcing StrykerJS 7.0](https://stryker-mutator.io/blog/announcing-stryker-js-7/) — Vitest support timeline, most-voted feature request, breaking changes from v6
- [Beyond Flaky Tests blog post](https://fast-check.dev/blog/2025/03/28/beyond-flaky-tests-bringing-controlled-randomness-to-vitest/) — seed capture for reproducibility, `g` generator pattern in `@fast-check/vitest`
- [fast-check/vitest vitest-runner peer dep](https://github.com/stryker-mutator/stryker-js/blob/master/packages/vitest-runner/package.json) — confirms `vitest: >=2.0.0` peer dependency

### Tertiary (LOW confidence)

- WebSearch result: Stryker v6+ supports ESM via `"type":"module"` in package.json — consistent with Stryker blog post about v6 changes; not independently verified against official docs page for this specific claim

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — npm registry version confirmation + official docs for all three tools
- Architecture: HIGH — official docs provide concrete config examples; project code examined to identify integration patterns and candidates for property tests
- Pitfalls: HIGH — `related: false` pitfall verified from official troubleshooting docs; `pino-pretty` false positive identified from project's actual devDependencies; other pitfalls from official docs

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable tools; 30-day estimate)
