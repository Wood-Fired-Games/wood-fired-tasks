---
phase: quick-5
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/db/migrate.ts
  - src/mcp/index.ts
autonomous: true
requirements: [QUICK-5]

must_haves:
  truths:
    - "Two MCP server processes starting simultaneously do not crash each other during migration"
    - "A transient startup error (SQLITE_BUSY, contention) is retried, not fatal"
    - "The MCP server starts within Claude Code's connection timeout when the database is healthy"
  artifacts:
    - path: "src/db/migrate.ts"
      provides: "Migration runner with exclusive transaction lock"
      contains: "BEGIN EXCLUSIVE"
    - path: "src/mcp/index.ts"
      provides: "MCP entry point with startup retry on transient errors"
      exports: ["main"]
  key_links:
    - from: "src/mcp/index.ts"
      to: "src/db/migrate.ts"
      via: "createApp -> runMigrations"
      pattern: "runMigrations"
---

<objective>
Harden MCP server startup against the two most likely failure modes: migration race
conditions when multiple Claude sessions start near-simultaneously, and permanent failure
on transient SQLite contention errors.

Purpose: Claude Code marks an MCP server "failed" on any process.exit(1) during startup.
Once marked failed, no recovery occurs in that session. The fixes here prevent the two
most common paths to that outcome.

Output: Updated src/db/migrate.ts (exclusive migration lock) and src/mcp/index.ts
(retry on transient errors, structured exit).
</objective>

<execution_context>
@/home/stuart/.claude/get-shit-done/workflows/execute-plan.md
@/home/stuart/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/db/migrate.ts
@src/db/database.ts
@src/mcp/index.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Serialize migrations with an exclusive SQLite transaction lock</name>
  <files>src/db/migrate.ts</files>
  <action>
Wrap the `umzug.up()` call in `runMigrations` with a SQLite exclusive transaction so
that only one process at a time can discover-and-apply pending migrations.

Implementation:
- Before calling `umzug.up()`, run `db.exec('BEGIN EXCLUSIVE')` using the synchronous
  better-sqlite3 API. This blocks (up to busy_timeout=5000ms) until no other process
  holds a write lock, then acquires an exclusive lock for the duration.
- Run `umzug.up()` inside a try/finally that always calls `db.exec('COMMIT')` (or
  `db.exec('ROLLBACK')` on error) to release the lock.
- If `umzug.up()` finds no pending migrations (the common case for the second process),
  it returns immediately — the lock is held for milliseconds.
- Preserve the existing Umzug logger and SQLiteStorage class unchanged.
- Do NOT wrap individual migration files in this transaction — that's Umzug's
  responsibility. Only the discovery + log-insertion step benefits from the lock.

The resulting `runMigrations` function structure:
```typescript
export async function runMigrations(db: Database.Database): Promise<void> {
  db.exec('BEGIN EXCLUSIVE');
  try {
    const umzug = createUmzug(db);
    await umzug.up();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

Note: `db.exec` is synchronous in better-sqlite3 and is safe to call here. The async
boundary is only needed for the Umzug `up()` call which does async file I/O.
  </action>
  <verify>
Run the test suite to confirm no regressions:
  npm test -- --testPathPattern="migrate|database" 2>&1 | tail -20

Also verify the change compiles:
  npm run build 2>&1 | tail -10
  </verify>
  <done>
`npm test` passes for migration-related tests. `npm run build` exits 0. The
runMigrations function wraps umzug.up() in BEGIN EXCLUSIVE / COMMIT / ROLLBACK.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add startup retry for transient SQLite errors in MCP entry point</name>
  <files>src/mcp/index.ts</files>
  <action>
Replace the bare `main().catch(() => process.exit(1))` with a retry wrapper that
distinguishes transient SQLite contention from genuine fatal errors.

Implementation:
- Create a `isTransientError(err: unknown): boolean` helper that returns true when
  the error message includes any of: `SQLITE_BUSY`, `SQLITE_LOCKED`, `BEGIN EXCLUSIVE`.
- Create a `mainWithRetry(maxAttempts = 3, delayMs = 500)` wrapper that calls `main()`,
  and on transient error, waits `delayMs` (using `setTimeout` in a Promise) then
  retries. On the final attempt, or on any non-transient error, it re-throws.
- Replace the call site:
  ```typescript
  // Before
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

  // After
  mainWithRetry().catch((error) => {
    console.error('Fatal error during MCP startup:', error);
    process.exit(1);
  });
  ```
- Log each retry attempt to stderr so it is visible in MCP server logs:
  `console.error(\`MCP startup attempt \${attempt} failed (transient), retrying...\`, err.message)`
- Keep the existing `uncaughtException` and `unhandledRejection` handlers unchanged.
- Do not change the `main()` function itself.

The retry covers the window between `busy_timeout` expiry and Claude Code's connection
timeout — 3 attempts with 500ms delay adds at most 1.5s to startup, well within any
reasonable timeout.
  </action>
  <verify>
Build and verify the entry point compiles without type errors:
  npm run build 2>&1 | tail -10

Run the full test suite:
  npm test 2>&1 | tail -20

Inspect the compiled output to confirm retry logic is present:
  grep -n "mainWithRetry\|isTransient\|retry" /home/stuart/wood-fired-bugs/dist/mcp/index.js
  </verify>
  <done>
`npm run build` exits 0. `npm test` passes (839 tests). The compiled dist/mcp/index.js
contains the retry wrapper. The `main()` function signature is unchanged.
  </done>
</task>

</tasks>

<verification>
After both tasks:
1. `npm run build` exits 0 — TypeScript compiles cleanly.
2. `npm test` passes all 839 tests — no regressions from migration lock change.
3. `grep "BEGIN EXCLUSIVE" src/db/migrate.ts` shows the exclusive lock is present.
4. `grep "mainWithRetry" src/mcp/index.ts` confirms the retry wrapper is in use.
5. Manual smoke test: `node dist/mcp/index.js &amp; node dist/mcp/index.js` — both
   processes start without crashing (second one waits on the lock, then exits cleanly
   because no migrations are pending).
</verification>

<success_criteria>
- Migration race condition is closed: concurrent startups serialize via EXCLUSIVE lock
- Transient SQLITE_BUSY errors during startup are retried up to 3 times before failing
- All existing tests continue to pass
- MCP server connects successfully in new Claude Code sessions that previously showed "failed"
</success_criteria>

<output>
After completion, create `.planning/quick/5-review-mcp-server-startup-reliability-an/5-SUMMARY.md`
using the standard summary template.
</output>
