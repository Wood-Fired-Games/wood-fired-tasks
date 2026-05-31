/**
 * Tests for the per-rule token-bucket rate limiter (task #432).
 *
 * Coverage matches the acceptance criterion "rate-limit.test.ts
 * covers burst+steady-state token refill" and exercises:
 *
 *   - Default construction (uses WFT_ROUTER_DEFAULTS.max_dispatches_per_minute).
 *   - Burst: N back-to-back tryAcquire calls in 0 elapsed ms succeed
 *     up to burstCapacity; the (burstCapacity+1)th fails.
 *   - Steady-state refill: after waiting refill_ms, exactly one new
 *     token becomes available.
 *   - Fractional / lazy refill: remaining() reflects partial token
 *     accrual without crossing the integer threshold for tryAcquire.
 *   - Per-rule isolation: rule A's drain does not affect rule B.
 *   - Cap at burstCapacity even after a long idle.
 *   - Custom burstCapacity decoupled from tokensPerMinute.
 *   - reset() drops state so the next acquire is fully burst-capable.
 *   - tryAcquire on an empty bucket returns false without going negative.
 *
 * Clock is injected via the options bag — NO vi.useFakeTimers().
 */

import { describe, expect, it } from 'vitest';

import { WFT_ROUTER_DEFAULTS } from '../defaults.js';
import { RateLimiter } from '../rate-limit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a controllable clock. `tick(ms)` advances the underlying ms
 * counter; `now()` returns the current value.
 */
function makeClock(startMs = 1_000_000): { now: () => number; tick: (ms: number) => void } {
  let t = startMs;
  return {
    now: () => t,
    tick: (ms) => {
      t += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimiter (defaults)', () => {
  it('uses WFT_ROUTER_DEFAULTS.max_dispatches_per_minute when no options given', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({ now: clock.now });
    // Burst should equal the spec default (60).
    const expected = WFT_ROUTER_DEFAULTS.max_dispatches_per_minute;
    let acquired = 0;
    for (let i = 0; i < expected; i++) {
      if (limiter.tryAcquire('rule-A')) {
        acquired++;
      }
    }
    expect(acquired).toBe(expected);
    // (expected+1)th call exhausts and returns false.
    expect(limiter.tryAcquire('rule-A')).toBe(false);
  });
});

describe('RateLimiter (burst behaviour)', () => {
  it('allows burstCapacity back-to-back tryAcquires at zero elapsed time', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 5,
      now: clock.now,
    });
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(false);
  });

  it('after draining, refills exactly one token per refill_ms', () => {
    const clock = makeClock();
    // 60 tokens/min = 1 token per 1000 ms.
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 1,
      now: clock.now,
    });
    expect(limiter.tryAcquire('r')).toBe(true); // drain
    expect(limiter.tryAcquire('r')).toBe(false); // empty
    clock.tick(999); // not quite enough
    expect(limiter.tryAcquire('r')).toBe(false);
    clock.tick(1); // now exactly 1000 ms elapsed → 1 token
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(false);
  });

  it('remaining() reflects fractional refill without enabling acquire', () => {
    const clock = makeClock();
    // 60/min = 1 per 1000 ms; 500 ms = 0.5 token.
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 1,
      now: clock.now,
    });
    limiter.tryAcquire('r'); // drain to 0
    clock.tick(500);
    expect(limiter.remaining('r')).toBeCloseTo(0.5, 5);
    expect(limiter.tryAcquire('r')).toBe(false); // 0.5 < 1
    clock.tick(500);
    expect(limiter.remaining('r')).toBeCloseTo(1.0, 5);
    expect(limiter.tryAcquire('r')).toBe(true);
  });
});

describe('RateLimiter (steady-state)', () => {
  it('over one full minute after a burst, allows exactly tokensPerMinute more dispatches', () => {
    const clock = makeClock();
    const tpm = 10;
    const limiter = new RateLimiter({
      tokensPerMinute: tpm,
      burstCapacity: tpm,
      now: clock.now,
    });
    // Burn the initial burst.
    for (let i = 0; i < tpm; i++) {
      expect(limiter.tryAcquire('r')).toBe(true);
    }
    expect(limiter.tryAcquire('r')).toBe(false);
    // Advance one minute → bucket refills exactly to capacity (capped).
    clock.tick(60_000);
    let acquired = 0;
    while (limiter.tryAcquire('r')) {
      acquired++;
      if (acquired > tpm * 2) break; // safety
    }
    expect(acquired).toBe(tpm);
  });

  it('caps refill at burstCapacity even after a long idle', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 5,
      now: clock.now,
    });
    // Drain bucket.
    for (let i = 0; i < 5; i++) limiter.tryAcquire('r');
    expect(limiter.tryAcquire('r')).toBe(false);
    // Idle for ten minutes — way more than burst capacity worth.
    clock.tick(10 * 60_000);
    expect(limiter.remaining('r')).toBe(5); // capped
  });
});

describe('RateLimiter (custom burst decoupled from steady-state)', () => {
  it('honours a burstCapacity smaller than tokensPerMinute', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 2,
      now: clock.now,
    });
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(false);
  });

  it('honours a burstCapacity larger than tokensPerMinute', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 6,
      burstCapacity: 12,
      now: clock.now,
    });
    let acquired = 0;
    for (let i = 0; i < 12; i++) {
      if (limiter.tryAcquire('r')) acquired++;
    }
    expect(acquired).toBe(12);
    expect(limiter.tryAcquire('r')).toBe(false);
  });
});

describe('RateLimiter (per-rule isolation)', () => {
  it("rule A's drain does not affect rule B's bucket", () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 3,
      now: clock.now,
    });
    expect(limiter.tryAcquire('A')).toBe(true);
    expect(limiter.tryAcquire('A')).toBe(true);
    expect(limiter.tryAcquire('A')).toBe(true);
    expect(limiter.tryAcquire('A')).toBe(false);
    // Rule B starts cold with a full burst capacity.
    expect(limiter.tryAcquire('B')).toBe(true);
    expect(limiter.tryAcquire('B')).toBe(true);
    expect(limiter.tryAcquire('B')).toBe(true);
    expect(limiter.tryAcquire('B')).toBe(false);
  });
});

describe('RateLimiter.reset', () => {
  it('drops all per-rule state so the next acquire starts cold (full burst)', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 2,
      now: clock.now,
    });
    limiter.tryAcquire('r');
    limiter.tryAcquire('r');
    expect(limiter.tryAcquire('r')).toBe(false);
    limiter.reset();
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(false);
  });
});

describe('RateLimiter (empty bucket safety)', () => {
  it('tryAcquire on empty bucket returns false without overdrawing remaining()', () => {
    const clock = makeClock();
    const limiter = new RateLimiter({
      tokensPerMinute: 60,
      burstCapacity: 1,
      now: clock.now,
    });
    expect(limiter.tryAcquire('r')).toBe(true);
    expect(limiter.tryAcquire('r')).toBe(false);
    expect(limiter.tryAcquire('r')).toBe(false);
    expect(limiter.tryAcquire('r')).toBe(false);
    // remaining stays non-negative.
    expect(limiter.remaining('r')).toBeGreaterThanOrEqual(0);
    expect(limiter.remaining('r')).toBeLessThan(1);
  });
});
