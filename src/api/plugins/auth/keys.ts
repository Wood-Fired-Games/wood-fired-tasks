/**
 * API key helpers — hashing + production validation.
 *
 * Extracted from `src/api/plugins/auth.ts` during the Phase 28 (Plan 28-04)
 * chain split. The runtime behaviour of `hashKey` and
 * `validateApiKeysForProduction` is byte-identical to the pre-split
 * implementation; only the file location changed so the new chain plugin at
 * `src/api/plugins/auth/index.ts` and the legacy strategy at
 * `src/api/plugins/auth/strategies/legacy.ts` can import them without a
 * circular reference back through the shim at `src/api/plugins/auth.ts`.
 *
 * The legacy shim re-exports both functions verbatim, so existing
 * `import { hashKey } from '../plugins/auth.js'` callers (e.g. routes/events.ts,
 * sse-caps.test.ts, the legacy strategy module) keep working unchanged.
 */
import { createHash } from 'crypto';

/**
 * Placeholder substrings rejected in production keys (case-insensitive contains check).
 *
 * Substring matches catch keys that embed an obvious placeholder phrase even if
 * padded to satisfy the length floor (e.g. "change-me-to-a-real-keyxxxxxxxxxx").
 */
const PLACEHOLDER_SUBSTRINGS = ['change-me-to-a-real-key', 'changeme', 'placeholder', 'example'];

/**
 * Placeholder values rejected in production keys (exact lowercase match).
 *
 * Exact matches catch the literal short placeholders the audit named without
 * false-positive on legitimate keys that happen to include the chars "test"
 * or "dev" elsewhere.
 */
const PLACEHOLDER_EXACT = new Set(['test', 'dev', 'placeholder']);

/**
 * Minimum length required for each API key when NODE_ENV=production.
 * 32 characters gives ~190 bits of entropy if generated from a hex/base64 RNG.
 */
const MIN_PRODUCTION_KEY_LENGTH = 32;

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
 * Validate API keys for a production environment.
 *
 * Throws an Error listing every failure mode. The error message references
 * keys by their 1-based index — it never includes the key value itself, so
 * the error is safe to log.
 *
 * Rules:
 * - At least one key must be present.
 * - Every key must be at least 32 characters.
 * - No key may contain a known placeholder substring (case-insensitive).
 * - No key may equal a known placeholder value (lowercased).
 * - No key may be a single character repeated (zero entropy).
 */
export function validateApiKeysForProduction(keys: string[]): void {
  const errors: string[] = [];

  if (keys.length === 0) {
    errors.push('API_KEYS must contain at least one key (got empty list)');
  }

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const idx = i + 1;

    if (k.length === 0) {
      errors.push(`key #${idx}: empty value`);
      continue;
    }
    if (k.length < MIN_PRODUCTION_KEY_LENGTH) {
      errors.push(
        `key #${idx}: must be at least ${MIN_PRODUCTION_KEY_LENGTH} characters (got ${k.length})`,
      );
    }
    const lower = k.toLowerCase();
    for (const phrase of PLACEHOLDER_SUBSTRINGS) {
      if (lower.includes(phrase)) {
        errors.push(`key #${idx}: contains placeholder phrase "${phrase}"`);
      }
    }
    if (PLACEHOLDER_EXACT.has(lower)) {
      errors.push(`key #${idx}: matches known placeholder value`);
    }
    if (new Set(k).size === 1) {
      errors.push(`key #${idx}: single character repeated (no entropy)`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `API_KEYS validation failed for production:\n  - ${errors.join('\n  - ')}\n` +
        `Set API_KEYS to comma-separated keys of at least ${MIN_PRODUCTION_KEY_LENGTH} ` +
        `characters each, with sufficient entropy and no placeholder phrases.`,
    );
  }
}
