/**
 * API key helpers — SHA-256 hashing for the MCP legacy-key match path.
 *
 * `hashKey` / `precomputeHashedEntries` were extracted from
 * `src/api/plugins/auth.ts` during the Phase 28 (Plan 28-04) chain split so
 * the chain plugin and (formerly) the legacy strategy could import them
 * without a circular reference back through the shim at
 * `src/api/plugins/auth.ts`.
 *
 * The v2.0 auth cutover removed the legacy X-API-Key REST strategy and the
 * production `validateApiKeysForProduction` gate. What remains is pure
 * key-hashing, still consumed by the MCP stdio actor-resolution path
 * (`src/mcp/index.ts` → `src/mcp/identity-resolution.ts`) and by SSE
 * fingerprinting in `routes/events.ts`. The legacy shim re-exports `hashKey`
 * verbatim so existing `import { hashKey } from '../plugins/auth.js'` callers
 * keep working unchanged.
 */
import { createHash } from 'crypto';
import type { ApiKeyEntry } from '../../../config/env.js';

/**
 * SHA-256 hash of a key, returned as a 32-byte Buffer.
 *
 * Hashing both sides of the comparison guarantees `timingSafeEqual` receives
 * equal-length buffers, eliminating the length-leak that arises from comparing
 * raw keys of different lengths.
 */
export function hashKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Pre-compute the SHA-256 hash + label for each parsed API_KEYS entry.
 *
 * A pure key-hashing utility (NOT an auth strategy): it returns one
 * `{ hash, label }` record per entry so callers can constant-time-compare a
 * supplied key against the configured set without re-hashing per request. The
 * MCP boot path (`src/mcp/index.ts`, `src/mcp/identity-resolution.ts`) relies
 * on this independently of the REST auth chain.
 *
 * Relocated here from the (now-removed) legacy X-API-Key strategy as part of
 * the v2.0 auth cutover (Phase 0) so it survives that strategy's deletion.
 */
export function precomputeHashedEntries(
  entries: ApiKeyEntry[],
): Array<{ hash: Buffer; label: string }> {
  return entries.map((e) => ({ hash: hashKey(e.key), label: e.label }));
}
