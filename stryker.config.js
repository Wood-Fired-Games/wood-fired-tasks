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
const includes = shardGlobsRaw && shardGlobsRaw.trim()
  ? shardGlobsRaw.trim().split(/\s+/)
  : ['src/**/*.ts'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
    related: false,
  },
  coverageAnalysis: 'perTest',
  mutate: [...includes, ...exclusions],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  typescriptChecker: {
    prioritizePerformanceOverAccuracy: true,
  },
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
