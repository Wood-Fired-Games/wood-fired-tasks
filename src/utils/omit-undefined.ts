/**
 * Strip keys whose value is exactly `undefined` from an object, returning a new
 * object that carries only the defined (including explicit `null`) entries.
 *
 * ## Why this exists (exactOptionalPropertyTypes)
 *
 * With `exactOptionalPropertyTypes: true`, an optional property `prop?: T` is
 * NOT the same as `prop: T | undefined`: passing an explicit `undefined` for
 * `prop` no longer satisfies `prop?: T`. Zod's `.optional()` produces
 * `T | undefined` (a present key whose value may be `undefined`), so a
 * `z.infer` result spread into an exact-optional DTO/param triggers TS2379 /
 * TS2375 at the consumption boundary.
 *
 * This helper is the call-site fix recommended by the #778 audit: it removes
 * the `undefined`-valued keys so the resulting object's optional props are
 * "key absent" rather than "key present = undefined".
 *
 * ## Three-state convention preserved (absent / null / value)
 *
 * The Create/Update DTOs in `src/types/task.ts` encode three distinct states:
 *   - key **absent**   → leave the column untouched
 *   - explicit `null`  → clear the column
 *   - a **value**      → set the column
 *
 * `omitUndefined` ONLY removes keys whose value is `undefined`. Explicit `null`
 * is a defined value and is **kept verbatim**, so the "clear the column"
 * semantics survive. A key that was already absent stays absent. This is a pure
 * type-narrowing / key-pruning operation with no runtime behaviour change at
 * the DTO boundary (the repository update builders already branch on
 * `key in dto` / `dto.key !== undefined`, never on the literal `undefined`
 * value of a present key).
 *
 * The return type maps every property to optional, which is exactly what an
 * exact-optional target wants: each surviving key holds a non-`undefined`
 * value, and missing keys are genuinely missing.
 */
export function omitUndefined<T extends object>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) {
      out[key as string] = value;
    }
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
