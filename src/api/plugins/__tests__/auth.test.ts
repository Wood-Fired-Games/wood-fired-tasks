import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { validateApiKeysForProduction, hashKey } from '../auth.js';

describe('validateApiKeysForProduction', () => {
  it('rejects an empty list of keys', () => {
    expect(() => validateApiKeysForProduction([])).toThrow(/at least one key/i);
  });

  it('rejects a key shorter than 32 characters', () => {
    expect(() => validateApiKeysForProduction(['short'])).toThrow(/at least 32 characters/i);
  });

  it('rejects a key shorter than 32 even if it has good entropy', () => {
    // 31 chars, mixed
    const key = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o';
    expect(key).toHaveLength(31);
    expect(() => validateApiKeysForProduction([key])).toThrow(/at least 32 characters/i);
  });

  it('rejects a key containing the change-me-to-a-real-key phrase (case-insensitive, padded long)', () => {
    const padded = 'change-me-to-a-real-key' + 'X'.repeat(10);
    expect(padded.length).toBeGreaterThanOrEqual(32);
    expect(() => validateApiKeysForProduction([padded])).toThrow(
      /placeholder phrase "change-me-to-a-real-key"/,
    );
  });

  it('rejects a key containing the changeme phrase', () => {
    const padded = 'CHANGEME' + 'Q'.repeat(30);
    expect(() => validateApiKeysForProduction([padded])).toThrow(/placeholder phrase "changeme"/);
  });

  it('rejects a key containing the placeholder phrase', () => {
    const padded = 'aaa-placeholder-aaa' + 'Q'.repeat(20);
    expect(() => validateApiKeysForProduction([padded])).toThrow(
      /placeholder phrase "placeholder"/,
    );
  });

  it('rejects a key containing the example phrase', () => {
    const padded = 'example-example-example-example-x';
    expect(padded.length).toBeGreaterThanOrEqual(32);
    expect(() => validateApiKeysForProduction([padded])).toThrow(/placeholder phrase "example"/);
  });

  it('rejects an exact placeholder value (test)', () => {
    expect(() => validateApiKeysForProduction(['test'])).toThrow(
      /matches known placeholder value/i,
    );
  });

  it('rejects an exact placeholder value (dev)', () => {
    expect(() => validateApiKeysForProduction(['dev'])).toThrow(/matches known placeholder value/i);
  });

  it('rejects an exact placeholder value (placeholder)', () => {
    expect(() => validateApiKeysForProduction(['placeholder'])).toThrow();
  });

  it('rejects a key that is a single character repeated', () => {
    const key = 'a'.repeat(32);
    expect(() => validateApiKeysForProduction([key])).toThrow(/single character repeated/i);
  });

  it('rejects a key that is uppercase single character repeated', () => {
    const key = 'Z'.repeat(40);
    expect(() => validateApiKeysForProduction([key])).toThrow(/single character repeated/i);
  });

  it('accepts a 32-character key with mixed entropy', () => {
    const key = 'k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6';
    expect(key).toHaveLength(32);
    expect(() => validateApiKeysForProduction([key])).not.toThrow();
  });

  it('accepts multiple valid keys', () => {
    const keys = ['k1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6', 'mNpQrStUvWxYz1234567890aBcDeFgHi'];
    expect(() => validateApiKeysForProduction(keys)).not.toThrow();
  });

  it('lists every failing key in the error message', () => {
    try {
      validateApiKeysForProduction(['short', 'change-me-to-a-real-key-padded-xyz']);
      throw new Error('expected validation to throw');
    } catch (err: any) {
      expect(err.message).toMatch(/key #1/);
      expect(err.message).toMatch(/key #2/);
    }
  });

  it('does NOT include the raw key value in the error message', () => {
    const secret = 'this-secret-should-never-be-logged-x';
    try {
      validateApiKeysForProduction(['short', secret]); // short fails, secret passes length but otherwise no phrase
    } catch (err: any) {
      expect(err.message).not.toContain(secret);
    }
    // The secret has 36 chars and no placeholder, so the only failure should be 'short'
    expect(() => validateApiKeysForProduction([secret])).not.toThrow();
  });
});

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
