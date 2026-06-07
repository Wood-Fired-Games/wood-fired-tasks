import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false, // Run test files sequentially to avoid env var conflicts
    // task #823: several integration tests do real work in setup/body — run
    // migrations (umzug cold-imports ~30 migration modules), boot the API
    // server, or spawn the CLI. The 5s test / 10s hook vitest defaults are too
    // tight for them under load, and ESPECIALLY under Stryker's mutation dry
    // run, which executes the FULL suite serially against INSTRUMENTED code with
    // `reloadEnvironment: true` (module caches cleared per test, so every
    // migration-running test re-pays the cold-import cost). A timed-out hook
    // there fails the dry run and reds every shard. These ceilings only raise
    // the upper bound — fast tests still finish fast — so they cut flakiness in
    // normal CI without weakening any assertion.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
    // task #773: `vitest bench` uses its OWN include/exclude globs and does NOT
    // inherit `test.exclude` above. Without this block, bench mode re-discovers
    // every `*.bench.ts` checked out under `.claude/worktrees/agent-*/` (the
    // isolation:"worktree" subagent checkouts from task #717), so each bench ran
    // N+1 times — once for the canonical tree and once per live sibling worktree.
    // That inflated runtime and polluted the comparison output with duplicate
    // suites. Mirror the worktree/dist/node_modules excludes here so `npm run
    // test:bench` only ever discovers the canonical `*.bench.ts` files.
    benchmark: {
      include: ['**/*.bench.ts'],
      exclude: ['dist/**', 'node_modules/**', '.claude/worktrees/**'],
    },
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
