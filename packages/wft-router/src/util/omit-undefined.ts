/**
 * Strip keys whose value is exactly `undefined` from an object, returning a new
 * object that carries only the defined (including explicit `null`) entries.
 *
 * Mirrors `src/utils/omit-undefined.ts` in the root package — duplicated here
 * because `wft-router` is a self-contained workspace package and does not import
 * from the root `src/` tree.
 *
 * ## Why this exists (exactOptionalPropertyTypes)
 *
 * With `exactOptionalPropertyTypes: true`, an optional property `prop?: T` is
 * NOT the same as `prop: T | undefined`: passing an explicit `undefined` for
 * `prop` no longer satisfies `prop?: T`. Object literals assembled from
 * `T | undefined` values (parsed SSE payloads, injected `fetchImpl`/`metrics`,
 * etc.) therefore trip TS2375/TS2379 at the consumption boundary. This helper
 * removes the `undefined`-valued keys so the surviving optional props are
 * "key absent" rather than "key present = undefined".
 *
 * Explicit `null` is a defined value and is kept verbatim (preserves any
 * absent / null / value three-state). Pure key-pruning; no runtime behaviour
 * change for consumers that branch on `key in obj` / `obj.key !== undefined`.
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
