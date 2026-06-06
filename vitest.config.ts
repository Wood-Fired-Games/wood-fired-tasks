import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false, // Run test files sequentially to avoid env var conflicts
    // Strip inherited OIDC_* env vars before each file so a developer shell that
    // exports a partial set (e.g. ~/.bashrc's lone OIDC_CLIENT_ID for `tasks
    // login`) can't trip loadConfig's all-or-nothing OIDC rule. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    // task #212: keep *.bench.ts out of the normal `npm test` run. Vitest still
    // discovers them when invoked via `vitest bench` because that mode uses its
    // own includeBench glob (defaulting to `**/*.bench.{js,ts}`) which ignores
    // this exclude list.
    // '.claude/worktrees/**' (task #717): isolation:"worktree" subagents create
    // checkouts under .claude/worktrees/ with symlinked node_modules. Without this
    // exclude, default-root discovery picks up both the worktree copies of our own
    // tests AND thousands of dependency-bundled *.test.js files, ballooning and
    // hanging the run. Excluding the dir keeps `npm test` correct while worktrees exist.
    exclude: ['dist/**', 'node_modules/**', '**/*.bench.ts', '.claude/worktrees/**'],
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
        // task #249 ratchet: bare-spot tests for CLI commands (completed,
        // completions, db-check, doctor, stats), CLI output formatters
        // (formatters, json-output), CLI prompts (interactive), and MCP-remote
        // glue (register-tools, rest-client) lifted coverage well above the
        // audit targets (lines/functions 80, branches 70). Current actuals
        // sit around 88/87/77/87 — these thresholds reserve a ~3 point safety
        // margin below the current numbers so unrelated future work has room
        // to land without retripping the gate, while still asserting the
        // post-#249 quality floor.
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});
