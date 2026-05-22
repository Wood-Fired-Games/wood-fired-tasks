// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
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
