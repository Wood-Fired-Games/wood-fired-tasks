import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { hashKey } from '../auth.js';

// Note: `validateApiKeysForProduction` and its tests were removed in the v2.0
// release-blocker fix (H2). The legacy X-API-Key REST strategy is gone (REST
// authenticates via PAT → session only), so the production fatal gate that
// validated API_KEYS no longer guarded any functional feature — it only
// aborted boot for upgraders who correctly dropped API_KEYS. `hashKey`
// survives for the MCP legacy-key match path and SSE fingerprinting.

describe('hashKey', () => {
  it('produces a 32-byte SHA-256 digest', () => {
    const buf = hashKey('hello');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf).toHaveLength(32);
  });

  it('is deterministic — same input yields same output', () => {
    const a = hashKey('the-quick-brown-fox');
    const b = hashKey('the-quick-brown-fox');
    expect(a.equals(b)).toBe(true);
  });

  it('matches a plain crypto SHA-256 of the same input', () => {
    const key = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6';
    const expected = createHash('sha256').update(key, 'utf8').digest();
    expect(hashKey(key).equals(expected)).toBe(true);
  });

  it('produces different digests for different inputs', () => {
    expect(hashKey('a').equals(hashKey('b'))).toBe(false);
  });

  it('produces different digests for inputs that differ only at the end', () => {
    // Property: even a one-char tail change avalanches the entire 256-bit digest.
    const a = hashKey('k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6');
    const b = hashKey('k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o7');
    expect(a.equals(b)).toBe(false);
  });
});
