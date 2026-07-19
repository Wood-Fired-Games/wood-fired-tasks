// @ts-check

// Task #252: per-shard CI runs need to restrict mutation to a subset of src/.
// Stryker's --mutate CLI flag does NOT accumulate (later --mutate overrides
// earlier ones), so we drive shard partitioning via STRYKER_MUTATE_GLOBS env
// var: a whitespace-separated list of include globs. Exclusions are always
// applied. When the env var is unset (local `npm run test:mutation` runs), we
// fall back to mutating the full src/ tree.
const exclusions = [
  '!src/**/__tests__/**',
  '!src/**/*.test.ts',
  '!src/db/migrate.ts',
  '!src/cli/bin/tasks.ts',
];
const shardGlobsRaw = process.env.STRYKER_MUTATE_GLOBS;
const includes =
  shardGlobsRaw && shardGlobsRaw.trim() ? shardGlobsRaw.trim().split(/\s+/) : ['src/**/*.ts'];

// Task #823: the two heaviest shards (api-routes ~1735 mutants ~7h, and
// services+db+repos ~3999 mutants ~5.5h) blew the 300-min GH job ceiling, so
// they are split further in mutation.yml. To split a directory WITHOUT letting
// a newly-added file silently fall out of all shards, the "rest" shard of a
// split uses STRYKER_MUTATE_EXCLUDE: it mutates the WHOLE directory glob minus
// the negation patterns naming its siblings' files. Any new file in that
// directory therefore lands in the rest shard automatically. Each entry MUST be
// a Stryker negation glob, e.g. `!src/services/wsjf*.ts`.
const shardExcludeRaw = process.env.STRYKER_MUTATE_EXCLUDE;
const shardExcludes =
  shardExcludeRaw && shardExcludeRaw.trim() ? shardExcludeRaw.trim().split(/\s+/) : [];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
    related: false,
  },
  coverageAnalysis: 'perTest',
  mutate: [...includes, ...shardExcludes, ...exclusions],
  // TypeScript 7 (native port, bumped in PR #91) removed `ts.parseConfigFileTextToJson`,
  // which Stryker's sandbox TSConfigPreprocessor and its `typescript` checker both call —
  // no Stryker release (≤9.6.1) supports the TS7 API yet. To keep mutation testing running
  // on TS7 without leaving sandbox mode we:
  //   (a) drop the `typescript` checker so Stryker never invokes the TS compiler API, and
  //   (b) keep tsconfig.json OUT of the sandbox via `ignorePatterns`. The crash is at
  //       ts-config-preprocessor.js:46 (`ts.parseConfigFileTextToJson`), but line 43 guards
  //       it with `if (project.files.get(tsconfigFileName))` — so if tsconfig.json is not a
  //       sandbox file the preprocessor no-ops instead of crashing. tsconfig.json has no
  //       `paths`/`extends`, and vitest compiles via esbuild, so nothing in the sandbox
  //       needs it. (`inPlace: true` also skips the preprocessor, but it makes vitest
  //       discover the .stryker-tmp backup copies of tests, breaking import.meta.url-based
  //       asset resolution — so we avoid it.)
  // Trade-off: mutants that would be compile errors are no longer filtered out up front —
  // they run through vitest and are scored as killed/survived. Revert once Stryker supports TS7.
  ignorePatterns: ['tsconfig.json'],
  reporters: ['html', 'clear-text', 'progress'],
  thresholds: {
    high: 80,
    low: 60,
    // Task #252: per-shard CI runs must NOT enforce break — only a fraction of
    // src/ is mutated per shard so the per-shard score is meaningless. The
    // unified break threshold is enforced by scripts/aggregate-mutation-reports.ts
    // against the merged JSON. Set STRYKER_DISABLE_BREAK_THRESHOLD=1 in the
    // shard CI step to disable the local break gate; default local invocations
    // (`npm run test:mutation`) keep enforcing 75%.
    break: process.env.STRYKER_DISABLE_BREAK_THRESHOLD === '1' ? null : 75,
  },
  packageManager: 'npm',
};
