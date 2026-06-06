# Async / Promise Linting

> Status: **active** as of project 37 phase-1 (task #762).
> Gate: enforced by the existing CI `lint` job (`npm run lint` → `biome check .`).

## Decision: Biome-only (no ESLint overlay)

This repo is **Biome-only** (`@biomejs/biome` 2.4.16; no ESLint toolchain). We
evaluated adding a narrow `typescript-eslint` overlay solely to get
`@typescript-eslint/no-floating-promises` / `no-misuses-promises`, versus using
Biome's native type-aware equivalents.

**Decision: stay Biome-only.** Biome 2.x ships first-class, type-aware
`noFloatingPromises` and `noMisusedPromises` rules (the `types` rule domain,
currently in the `nursery` group). They detect the same class of defects the
typescript-eslint rules do, and they run inside the single `biome check .`
invocation that CI already executes.

Rationale:

- **No second lint stack.** Adding ESLint would mean a parallel resolver,
  config, plugin set, and `tsconfig`-driven type-info program — a heavy second
  toolchain to install, version-pin, and keep green. The acceptance criteria
  explicitly want to avoid destabilizing the repo; one lint engine is the
  conservative choice.
- **Already wired into CI.** Because the rules live in `biome.json`, the
  existing `lint` job (and the `quality` / `quality:fast` aggregates) enforce
  them with zero new CI steps.
- **Type-aware.** Biome runs its multi-file project scan to infer types when a
  type-domain rule is enabled, so it catches floating promises returned from
  functions defined in other modules — not just lexically-local ones.

## What was enabled

In `biome.json`, at the **top level** of `linter.rules` (this placement is
load-bearing — see below):

```jsonc
"linter": {
  "rules": {
    "nursery": {
      "noFloatingPromises": "error",
      "noMisusedPromises": "error"
    }
  }
}
```

- `noFloatingPromises` (`error`) — a Promise-valued statement that is not
  `await`-ed, `return`-ed, `void`-ed, or given a `.then(onF, onR)` /
  `.catch(onR)` rejection handler is a violation.
- `noMisusedPromises` (`error`) — a Promise used where a Promise is almost
  certainly a mistake (e.g. as a boolean condition).

Both ship `error`-level from the start (the rule surface is small and the repo
is already clean after one fix), satisfying the "conservative and
warning-free" requirement.

### Why no `linter.domains` knob is set

`noFloatingPromises` / `noMisusedPromises` belong to Biome's `types` rule
domain (rules that require type inference). You can bulk-enable a domain with
`linter.domains.types: "all" | "recommended"`, but that pulls in **every**
type-domain rule — broader than we want for a conservative first gate.
Instead we enable the two specific rules by name. Verified empirically:
enabling the rules by name **also activates** Biome's project-wide type scan
(a `biome check .` run jumps from ~180ms to ~470ms, and the rules fire), so the
explicit `domains` setting is unnecessary. Enabling the rules by name is the
minimal knob.

### Placement gotcha (Biome 2.4.16)

The rules must be enabled in the **top-level** `linter.rules`, *not* inside an
`overrides[].linter.rules` block. In 2.4.16, a type-domain rule placed only in
an override does **not** trigger the project-wide type-inference pass, so it
silently never fires — even during a full `biome check .`. We therefore enable
at top level and use an override only to turn the rules **off** for the
excluded paths below.

## Scope: production TypeScript only

The rules target production TypeScript under `src/**` and
`packages/wft-router/src/**`. They are turned **off** via an override for:

- test files — `**/__tests__/**`, `**/*.test.ts(x)`, `**/*.spec.ts`,
  `**/*.property.test.ts`, `**/*.bench.ts`
- non-production helper code — `scripts/**`, `docs/**`, and root
  `*.mjs` / `*.cjs` / `*.js`

Tests are excluded deliberately: they routinely fire-and-forget timers,
in-flight requests, and abort signals where a floating promise is not a defect,
and forcing `void`/`await` there adds noise without catching real production
bugs. This is the conservative, warning-free path. If a future task wants
promise hygiene in tests, enable a test-scoped override then and burn down the
violations separately.

## Fire-and-forget convention

When a promise is intentionally not awaited in production code, make the intent
explicit with the `void` operator **and** a one-line rationale comment:

```ts
// fire-and-forget: metrics emission must not block the request path
void emitMetrics(event);
```

Do **not** use `void` to silence a promise that should actually be awaited —
that hides real ordering / unhandled-rejection bugs. Prefer `await` (or an
explicit `.catch(...)`) wherever the result or its failure matters.

## Violations fixed when the gate was introduced

- `src/api/start.ts` — the top-level `main()` entry call was a floating
  promise. Relying on the process-level `unhandledRejection` handler is exactly
  what the rule flags. Fixed properly with an explicit
  `main().catch(err => { console.error(...); process.exit(EX_SOFTWARE); })` so a
  failed boot produces a deterministic fatal log + non-zero exit. This was a
  latent robustness gap, not a cosmetic change.

No `noMisusedPromises` violations existed in production code. The one
`noFloatingPromises` hit in `docs/hooks/validate-sha.mjs` (`main()`) is outside
the production scope (a docs helper) and is excluded by the override above, not
silenced.

## How it is enforced in CI

No new CI step. The rules live in `biome.json`, so:

- the `lint` job runs `npm run lint` → `biome check .` → fails on any violation;
- `npm run quality` and `npm run quality:fast` include `lint`, so local
  quality gates enforce it too.

The type-aware scan runs automatically as part of `biome check .`; no separate
invocation or flag is required.

## Verifying the rule is live

```bash
# Should be clean (exit 0):
npm run lint

# Prove it fires: add a floating promise to a src/ file, then run a FULL check
# (single-file paths skip the type scan, so always check the whole project):
printf 'async function f(): Promise<void> {}\nexport function g() { f(); }\n' > src/__floatcheck__.ts
npx biome check .   # → lint/nursery/noFloatingPromises, exit 1
rm src/__floatcheck__.ts
```
