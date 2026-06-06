/**
 * In-process per-token debounce gate for `last_used_at` SQL writes.
 *
 * REQUIREMENTS PAT-03 mandates "≤ 1 last_used_at write / 10 min / token". This
 * module is the gate: the chain auth plugin calls `shouldTouchLastUsed(tokenId)`
 * before scheduling the `setImmediate(touchLastUsed)`. When the gate returns
 * `false`, the write is skipped.
 *
 * State: `Map<tokenId, lastWriteEpochMs>`. Keyed per-token so concurrent
 * traffic for different tokens never debounces a sibling. The value is the
 * `now` (epoch ms) at which the most recent `true` decision was made — i.e.
 * the moment the write was authorised, not necessarily the moment the write
 * landed in SQLite.
 *
 * Trade-offs (per Phase 28 Decision Q1 — `last_used_at` is observational,
 * not transactional):
 *   - Per-process: multi-instance deployments may over-count
 *     (each replica has its own Map). Acceptable.
 *   - Resets on restart: a fresh process always allows the first hit per
 *     token, regardless of how recently the previous process wrote.
 *     Acceptable — `last_used_at` recovers within 10 min of activity.
 *   - Unbounded growth: bounded in practice by the number of distinct
 *     tokens the process ever sees. ~8 bytes / entry; 10k tokens = 80 KB.
 *     No eviction policy (T-28-06-01 disposition: accept).
 *
 * Boundary semantics: comparison is strict `<` against `TTL_MS`. A call
 * exactly `TTL_MS` ms after the last `true` decision returns `true` again.
 *
 * Pure module — no I/O, no timers, no Fastify. Injectable `now` keeps tests
 * deterministic.
 *
 * @see src/api/plugins/auth/index.ts `scheduleLastUsedTouch` — sole consumer.
 */

/** 10 minutes in milliseconds. The only PAT-03 tuning knob. */
export const TTL_MS = 10 * 60 * 1000;

/**
 * Per-process cache. Module-scope is intentional: the gate IS the state.
 * Tests reset via `resetDebounceCacheForTests`; production code never mutates.
 */
const cache = new Map<number, number>();

/**
 * Return `true` if the caller should proceed with a `last_used_at` write for
 * `tokenId` — i.e. no recent write within `TTL_MS`. Side-effect: on a `true`
 * return, the cache is updated so subsequent calls within the window see
 * `false`.
 *
 * @param tokenId  `api_tokens.id` of the matched PAT row
 * @param now      Injectable clock; defaults to `Date.now()` for production
 */
export function shouldTouchLastUsed(tokenId: number, now: number = Date.now()): boolean {
  const last = cache.get(tokenId);
  if (last !== undefined && now - last < TTL_MS) {
    return false;
  }
  cache.set(tokenId, now);
  return true;
}

/**
 * Test-only helper. Clears the entire cache so unit and integration tests
 * can start from a known-empty state in `beforeEach`. Do NOT call from
 * production code paths.
 *
 * @internal
 */
export function resetDebounceCacheForTests(): void {
  cache.clear();
}

/**
 * Test-only helper. Overwrite the recorded last-write timestamp for a token
 * to simulate "the last successful write happened `now - epochMs` ago"
 * without sleeping for real time.
 *
 * Use in integration tests that need to drive the chain plugin past the
 * 10-minute boundary without actually waiting 10 minutes. Do NOT call from
 * production code paths.
 *
 * @internal
 */
export function _setLastWriteForTests(tokenId: number, epochMs: number): void {
  cache.set(tokenId, epochMs);
}
