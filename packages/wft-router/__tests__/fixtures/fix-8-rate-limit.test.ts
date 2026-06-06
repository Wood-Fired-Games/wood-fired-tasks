import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../../src/dispatch/rate-limit.js';
import { createRecordingLogger } from './harness.js';

// fix-8 / rate-limit: 200 events match one rule inside a 1 s window; dispatches
// are throttled to max_dispatches_per_minute, and every surplus drop increments
// a counter and emits a WARN. The limiter is the gate (tryAcquire); the dispatch
// loop owns the drop accounting + WARN, which this fixture exercises directly.

/** Deterministic injectable clock — no real wall-clock sleep is used. */
function fakeClock(start = 1_700_000_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('fix-8 / rate-limit', () => {
  it('throttles a 200-event burst to max_dispatches_per_minute and counts surplus drops', () => {
    const clock = fakeClock();
    const recorder = createRecordingLogger();
    const maxPerMinute = 10;
    const limiter = new RateLimiter({
      tokensPerMinute: maxPerMinute,
      burstCapacity: maxPerMinute,
      now: clock.now,
    });

    let dispatched = 0;
    let dropped = 0;
    // 200 events for the SAME rule key, spread across exactly one 1 s window
    // (200 * 5 ms = 1000 ms) so refill cannot meaningfully replenish the bucket.
    for (let i = 0; i < 200; i++) {
      if (limiter.tryAcquire('rule-1')) {
        dispatched++;
      } else {
        dropped++;
        recorder.warn({ rule_id: 'rule-1', dropped }, 'rate_limit_dropped');
      }
      clock.advance(5);
    }

    // Steady-state cap honoured: the burst is clamped near the minute budget.
    // A trickle of refill tokens (10/min over 1 s ≈ 0.17) never crosses 1, so
    // exactly the burst capacity is admitted.
    expect(dispatched).toBe(maxPerMinute);
    expect(dropped).toBe(200 - maxPerMinute);

    const warns = recorder.calls.warn;
    expect(warns.length).toBe(200 - maxPerMinute);
    expect(warns.every((w) => w.msg === 'rate_limit_dropped')).toBe(true);
    // The drop counter increments monotonically across the surplus.
    expect(warns[0]?.obj.dropped).toBe(1);
    expect(warns.at(-1)?.obj.dropped).toBe(200 - maxPerMinute);
  });

  it('refills capacity after the rolling minute elapses', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ tokensPerMinute: 2, burstCapacity: 2, now: clock.now });

    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(true);
    expect(limiter.tryAcquire('k')).toBe(false);

    // A full minute restores the burst capacity.
    clock.advance(60_000);
    expect(limiter.tryAcquire('k')).toBe(true);
  });

  it('meters each rule key independently', () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ tokensPerMinute: 1, burstCapacity: 1, now: clock.now });

    expect(limiter.tryAcquire('rule-a')).toBe(true);
    expect(limiter.tryAcquire('rule-a')).toBe(false);
    // A different rule has its own bucket, unaffected by rule-a's exhaustion.
    expect(limiter.tryAcquire('rule-b')).toBe(true);
  });
});
