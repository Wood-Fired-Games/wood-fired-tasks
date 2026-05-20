import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false, // Run test files sequentially to avoid env var conflicts
    // task #212: keep *.bench.ts out of the normal `npm test` run. Vitest still
    // discovers them when invoked via `vitest bench` because that mode uses its
    // own includeBench glob (defaulting to `**/*.bench.{js,ts}`) which ignores
    // this exclude list.
    exclude: ['dist/**', 'node_modules/**', '**/*.bench.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/types/**',
        'src/schemas/**',
        'src/db/migrate.ts',
        'src/db/migrations/**',
        'src/index.ts',
        'src/**/bin/**',
        'src/cli/bin/**',
        'src/api/start.ts',
        'src/mcp/index.ts',
        'src/mcp/remote/index.ts',
        'dist/**',
        'node_modules/**',
      ],
      thresholds: {
        // Baseline thresholds set to current actual coverage rounded down to the
        // nearest 5 (task 199). Original aspirational targets were
        // lines/functions 80, branches 70 — adjust upward as coverage improves.
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 65,
      },
    },
  },
});
