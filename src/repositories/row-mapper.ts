/**
 * Localized "unsafe boundary" helpers for SQLite row reads.
 *
 * `better-sqlite3` returns `unknown` from `.get()` / `.all()` because it has
 * no awareness of the column types the caller expects. Every repository
 * method therefore needs a cast from `unknown` to its row shape. Rather
 * than scatter `as Type[]` casts across every repo file (where they blend
 * in with the rest of the code and slip past review), we centralise the
 * cast here. Any new "I trust SQLite to return this shape" assertion in
 * the repo layer should funnel through these two helpers so that:
 *
 *   1. `grep "as " src/repositories/` only highlights edge cases
 *      (e.g. `info.lastInsertRowid as number`).
 *   2. Adding runtime row validation later (e.g. Zod parse) is a one-file
 *      change.
 *
 * SAFETY: The two casts inside this file are the canonical "trust SQLite's
 * column schema matches the TypeScript row type" boundary. The schema is
 * defined in `src/db/migrate.ts`; the row types live in `src/types/task.ts`.
 * Keep them in sync.
 */

// Statement-shape we accept: anything exposing the better-sqlite3 .get/.all
// signatures we use. We deliberately keep this structural so callers can
// pass either a prepared `Database.Statement` or a `db.prepare(...)` chain
// without coupling this helper to better-sqlite3's full generic surface.
interface GetCapable {
  get(...args: unknown[]): unknown;
}
interface AllCapable {
  all(...args: unknown[]): unknown[];
}

/**
 * Run `stmt.get(...args)` and assert the result is `T | undefined`.
 *
 * Use for single-row reads (`SELECT * FROM x WHERE id = ?`).
 */
export function mapRow<T>(stmt: GetCapable, ...args: unknown[]): T | undefined {
  return stmt.get(...args) as T | undefined;
}

/**
 * Run `stmt.all(...args)` and assert the result is `T[]`.
 *
 * Use for multi-row reads (`SELECT * FROM x WHERE ...`).
 */
export function mapRows<T>(stmt: AllCapable, ...args: unknown[]): T[] {
  return stmt.all(...args) as T[];
}
