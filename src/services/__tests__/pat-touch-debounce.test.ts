import { describe, it, expect, beforeEach } from 'vitest';
import { shouldTouchLastUsed, resetDebounceCacheForTests } from '../pat-touch-debounce.js';

/**
 * Unit tests for the in-process per-token debounce gate used by the chain
 * auth plugin to satisfy PAT-03 ("≤ 1 last_used_at write / 10 min / token").
 *
 * The module exports a pure function with an injectable `now` so tests can
 * cover the TTL boundary without sleeping. The cache lives at module scope —
 * `resetDebounceCacheForTests()` is called in `beforeEach` to isolate cases.
 *
 * TTL constant: 10 * 60 * 1000 ms = 600_000 ms (see `pat-touch-debounce.ts`).
 */

const TTL_MS = 10 * 60 * 1000;

describe('shouldTouchLastUsed (PAT-03 debounce gate)', () => {
  beforeEach(() => {
    resetDebounceCacheForTests();
  });

  it('first call for a token id returns true (cache miss → schedule)', () => {
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(true);
  });

  it('immediate second call for same id returns false (within TTL)', () => {
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(true);
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(false);
  });

  it('different token id within same window returns true (Map is per-id)', () => {
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(true);
    expect(shouldTouchLastUsed(2, 1_000_000)).toBe(true);
  });

  it('call at first + (TTL_MS - 1) for same id returns false (still inside window)', () => {
    const t0 = 1_000_000;
    expect(shouldTouchLastUsed(1, t0)).toBe(true);
    expect(shouldTouchLastUsed(1, t0 + TTL_MS - 1)).toBe(false);
  });

  it('call at first + TTL_MS for same id returns true (boundary: strict <)', () => {
    const t0 = 1_000_000;
    expect(shouldTouchLastUsed(1, t0)).toBe(true);
    expect(shouldTouchLastUsed(1, t0 + TTL_MS)).toBe(true);
  });

  it('call at first + TTL_MS + 1 for same id returns true (after TTL)', () => {
    const t0 = 1_000_000;
    expect(shouldTouchLastUsed(1, t0)).toBe(true);
    expect(shouldTouchLastUsed(1, t0 + TTL_MS + 1)).toBe(true);
  });

  it('after a successful (true) call, the map records the NEW timestamp', () => {
    // Chain: true at t=0, false at t=1000, true at t=TTL+1, then false at t=TTL+1+1
    const t0 = 1_000_000;
    expect(shouldTouchLastUsed(1, t0)).toBe(true);
    expect(shouldTouchLastUsed(1, t0 + 1_000)).toBe(false);
    const t2 = t0 + TTL_MS + 1;
    expect(shouldTouchLastUsed(1, t2)).toBe(true);
    expect(shouldTouchLastUsed(1, t2 + 1)).toBe(false);
  });

  it('resetDebounceCacheForTests() clears the map; first call after reset returns true', () => {
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(true);
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(false);
    resetDebounceCacheForTests();
    expect(shouldTouchLastUsed(1, 1_000_000)).toBe(true);
  });
});
