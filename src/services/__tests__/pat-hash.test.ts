import { describe, it, expect } from 'vitest';
import { hashToken, generateToken } from '../pat-hash.js';

describe('hashToken', () => {
  it('returns 64-character lowercase hex', () => {
    const hash = hashToken('any-string');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashToken('same-input')).toBe(hashToken('same-input'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });

  it('matches a known SHA-256 vector (FIPS 180-4: "abc")', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('generateToken', () => {
  it('token starts with wfb_pat_', () => {
    const result = generateToken();
    expect(result.token.startsWith('wfb_pat_')).toBe(true);
  });

  it('prefix is the literal wfb_pat_', () => {
    const result = generateToken();
    expect(result.prefix).toBe('wfb_pat_');
  });

  it('base32 body is exactly 32 chars', () => {
    const result = generateToken();
    expect(result.token.slice(8).length).toBe(32);
  });

  it('base32 body uses RFC 4648 alphabet (A-Z, 2-7, no padding)', () => {
    const result = generateToken();
    expect(result.token.slice(8)).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('suffix is the last 4 chars of the base32 body', () => {
    const result = generateToken();
    expect(result.suffix.length).toBe(4);
    expect(result.suffix).toBe(result.token.slice(-4));
  });

  it('hash matches hashToken(token) (round-trip)', () => {
    const result = generateToken();
    expect(result.hash).toBe(hashToken(result.token));
  });

  it('two successive calls produce different tokens (entropy)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken().token);
    }
    expect(tokens.size).toBe(100);
  });

  it('two successive calls produce different hashes (entropy)', () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      hashes.add(generateToken().hash);
    }
    expect(hashes.size).toBe(100);
  });
});
