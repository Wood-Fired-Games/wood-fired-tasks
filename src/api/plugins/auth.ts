import { createHash, timingSafeEqual } from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Placeholder substrings rejected in production keys (case-insensitive contains check).
 *
 * Substring matches catch keys that embed an obvious placeholder phrase even if
 * padded to satisfy the length floor (e.g. "change-me-to-a-real-keyxxxxxxxxxx").
 */
const PLACEHOLDER_SUBSTRINGS = [
  'change-me-to-a-real-key',
  'changeme',
  'placeholder',
  'example',
];

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

/**
 * Parse the API_KEYS environment variable into a trimmed, non-empty list.
 */
function parseApiKeys(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Fastify plugin: API key authentication on every request in its scope.
 *
 * - Reads `process.env.API_KEYS` at plugin register-time (comma-separated).
 * - In production, validates each configured key against the production rules
 *   above; throws synchronously, which causes Fastify to reject `register()`
 *   and bubble the error up to `createServer`. This fails the boot fast.
 * - In non-production environments, warns once if no keys are configured but
 *   still rejects every request (fail-closed).
 * - On each request, hashes the supplied `X-API-Key` header with SHA-256 and
 *   compares against pre-computed SHA-256 hashes of the configured keys
 *   using `crypto.timingSafeEqual` (constant-time, equal-length).
 * - Logs invalid auth attempts at `warn` with `{ ip, route }` — never the
 *   supplied key.
 *
 * This is the single canonical authentication path. The previous inline
 * implementation in `src/api/server.ts` has been removed in favour of this
 * plugin.
 */
const authPluginImpl: FastifyPluginAsync = async (fastify) => {
  const keys = parseApiKeys(process.env.API_KEYS);

  if (process.env.NODE_ENV === 'production') {
    // Throws synchronously on bad config — Fastify bubbles up to createServer
    // which surfaces to the caller (start.ts → process exit with non-zero).
    validateApiKeysForProduction(keys);
  } else if (keys.length === 0) {
    fastify.log.warn(
      'No API keys configured in API_KEYS env var. All API requests will be rejected.',
    );
  }

  const hashedKeys: Buffer[] = keys.map(hashKey);

  fastify.addHook('preHandler', async (request, reply) => {
    const supplied = request.headers['x-api-key'];

    if (typeof supplied !== 'string' || supplied.length === 0) {
      request.log.warn(
        { ip: request.ip, route: request.url },
        'Auth failure: missing X-API-Key',
      );
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Missing API key. Provide X-API-Key header.',
      });
    }

    const suppliedHash = hashKey(supplied);
    // Every configured-key hash is 32 bytes, so timingSafeEqual will not throw.
    const matched = hashedKeys.some((h) => timingSafeEqual(h, suppliedHash));

    if (!matched) {
      request.log.warn(
        { ip: request.ip, route: request.url },
        'Auth failure: invalid X-API-Key',
      );
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Invalid API key.',
      });
    }

    // Valid key — continue to route handler.
  });
};

/**
 * Wrap the plugin with `fastify-plugin` to skip Fastify's default scope
 * encapsulation. The `preHandler` hook added inside the plugin must apply to
 * every sibling route registered in the SAME parent scope (e.g. `/api/v1`),
 * not just to routes registered inside the plugin's own scope. Without `fp`,
 * the hook would be confined to the plugin's encapsulated context and the
 * sibling task/project/comment/dependency/event routes would bypass auth.
 */
const authPlugin = fp(authPluginImpl, {
  name: 'wfb-auth',
  fastify: '5.x',
});

export default authPlugin;
