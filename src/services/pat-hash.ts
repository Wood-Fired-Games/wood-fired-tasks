/**
 * Personal Access Token (PAT) hashing + generation utility.
 *
 * Pure functions — no I/O, no DB. SHA-256 lookup hash for Phase 28's auth
 * chain, plus RFC 4648 base32 token generation for Phase 28's mint command.
 *
 * Token format (locked by 27-CONTEXT.md):
 *   wfb_pat_<32 chars of RFC 4648 base32 (A-Z, 2-7), no padding>
 *
 * 20 random bytes = 160 bits of entropy = exactly 32 base32 chars (aligned,
 * so no `=` padding is needed).
 *
 * Base32 is hand-rolled per 27-RESEARCH §7 Pitfall 7 — npm base32 packages
 * are tiny + unaudited, and the algorithm is ~15 lines.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Literal token prefix; used by Phase 28's auth dispatcher to short-circuit. */
export const PAT_PREFIX = 'wfb_pat_';

/** RFC 4648 base32 alphabet: 26 uppercase letters + digits 2..7 (32 symbols). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32 encoder. Walks the byte stream emitting one char per 5
 * bits accumulated. For aligned input (length % 5 === 0) the output is
 * exactly `bytes.length * 8 / 5` chars with no padding.
 *
 * Caller (`generateToken`) always passes 20 bytes → 32 chars exactly.
 */
function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    // Remaining bits left-aligned into the next 5-bit window.
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * SHA-256 hex digest of a token string. Used by Phase 28 to look up an
 * `api_tokens` row by `hash` (unique index). No salt — the input is already
 * 160 bits of random entropy, so a salt buys nothing and would break the
 * single-lookup property.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a new PAT. Caller (Phase 28's mint endpoint) displays `token` exactly
 * once and stores `{ prefix, suffix, hash }` on the `api_tokens` row.
 *
 *   prefix — literal `wfb_pat_` (for safe display + dispatcher prefix match)
 *   suffix — last 4 chars of the base32 body (for safe display in `tokens list`)
 *   hash   — SHA-256 hex of the full token string (the only lookup key)
 */
export function generateToken(): {
  token: string;
  prefix: string;
  suffix: string;
  hash: string;
} {
  const body = encodeBase32(randomBytes(20));
  const token = `${PAT_PREFIX}${body}`;
  return {
    token,
    prefix: PAT_PREFIX,
    suffix: body.slice(-4),
    hash: hashToken(token),
  };
}
