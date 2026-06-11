import type { ZodType } from 'zod';

/**
 * Defensive JSON parse for a TEXT database column (task #930).
 *
 * THE single home for the read-side "JSON column → typed value" transform
 * that previously existed as five near-identical private copies
 * (`parseValueCharter` / `parseModelPolicy` in project.repository.ts,
 * `parseWsjfJson` in task.repository.ts, `parseCharter` in
 * project-charter-history.repository.ts, and `parseJson<T>` in
 * wsjf-history.repository.ts).
 *
 * Semantics (unchanged from every copy it replaces):
 * - A non-string input (NULL column, already-parsed value, corruption)
 *   surfaces as `null` — never throws.
 * - A non-JSON string (corruption / hand-edit) surfaces as `null` rather than
 *   crashing the whole query.
 * - Without `schema`, the parsed value is trusted as `T`: shape validation is
 *   enforced at the WRITE boundary, so read-side parsing trusts the stored
 *   bytes.
 * - With `schema`, the parsed value is ALSO validated on read (the
 *   `parseModelPolicy` behaviour): a non-conforming shape (corruption,
 *   forward-version row written by a newer build) degrades to `null` instead
 *   of leaking into strict response schemas downstream.
 */
export function parseJsonColumn<T>(raw: unknown, schema?: ZodType<T>): T | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!schema) return parsed as T;
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}
