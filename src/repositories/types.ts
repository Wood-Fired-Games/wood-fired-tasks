/**
 * Shared types for the repository layer.
 *
 * These types narrow the contract between repository methods and
 * `better-sqlite3`'s named-parameter binding. The previous code used
 * `Record<string, any>` as a workaround for SQLite's "anything-bindable"
 * surface, but that leaks `any` into callers and defeats type-narrowing
 * downstream.
 */

/**
 * Values that better-sqlite3 can bind to a named parameter without coercion.
 *
 * Repository filter/update accumulators in this codebase only pass strings
 * (status/title/assignee), numbers (ids, estimated_minutes), or null
 * (cleared optional columns). If a future caller needs Buffer/Date/bigint,
 * extend this union explicitly rather than widening back to `any`.
 */
export type SqlParamValue = string | number | null;

/** Named-parameter accumulator for prepared statements. */
export type SqlParams = Record<string, SqlParamValue>;
