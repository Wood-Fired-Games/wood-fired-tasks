/**
 * Per-rule token-bucket rate limiter (task #432).
 *
 * Implements the gate side of the spec's outbound rate-limiting
 * story (docs/event-router-design.md §"Rate limiting (outbound)",
 * line 448-454):
 *
 *   > Per-rule `max_dispatches_per_minute` (default 60). When the
 *   > limit trips, surplus events are queued (bounded; default
 *   > 1000 deep); over-queue drops with a WARN and a
 *   > `wft_router_rate_limit_dropped_total` counter.
 *
 * Scope split: this module owns the bucket-and-token bookkeeping
 * ONLY. The bounded overflow queue and the WARN/counter side-effect
 * belong to the dispatch loop (task #433) — `tryAcquire()` is the
 * gate; callers that lose the race queue separately.
 *
 * Algorithm: classic lazy-refill token bucket. Each `(ruleId)` keeps
 * its own bucket with `tokens: number` and `lastRefillMs: number`.
 * On every `tryAcquire`/`remaining`, we compute elapsed ms, add
 * `tokensPerMinute * elapsed / 60_000` tokens (cap at
 * `burstCapacity`), then either deduct 1 (acquire) or peek
 * (remaining).
 *
 * Burst semantics: with default `burstCapacity = tokensPerMinute`, a
 * cold bucket allows N back-to-back successful acquires (the burst)
 * and then exactly N/min in steady state. Operators can decouple
 * burst from steady-state by passing an explicit `burstCapacity`.
 *
 * Standalone-package isolation: no imports from root `src/`. Only
 * dependency is the local defaults constant.
 */

import { WFT_ROUTER_DEFAULTS } from './defaults.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  /** Tokens added per minute. Default WFT_ROUTER_DEFAULTS.max_dispatches_per_minute. */
  tokensPerMinute?: number;
  /** Max bucket capacity (burst size); defaults to tokensPerMinute. */
  burstCapacity?: number;
  /** Clock injection for tests. Defaults to () => Date.now(). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Internal bucket state
// ---------------------------------------------------------------------------

interface Bucket {
  /** Current token count. Fractional during partial refills. */
  tokens: number;
  /** Wall-clock ms at which `tokens` was last computed. */
  lastRefillMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly tokensPerMinute: number;
  private readonly burstCapacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly buckets: Map<string, Bucket> = new Map();

  /**
   * @param options.tokensPerMinute defaults to
   *   {@link WFT_ROUTER_DEFAULTS.max_dispatches_per_minute} (60).
   * @param options.burstCapacity defaults to `tokensPerMinute`. Pass
   *   a larger value to allow bigger bursts than the steady-state
   *   rate; pass a smaller value to clamp bursts below the
   *   steady-state rate.
   * @param options.now defaults to `Date.now`. Tests inject a
   *   controllable clock; production never sets this.
   */
  constructor(options: RateLimitOptions = {}) {
    this.tokensPerMinute = options.tokensPerMinute ?? WFT_ROUTER_DEFAULTS.max_dispatches_per_minute;
    this.burstCapacity = options.burstCapacity ?? this.tokensPerMinute;
    this.now = options.now ?? Date.now;
    this.refillPerMs = this.tokensPerMinute / 60_000;
  }

  /**
   * Attempt to consume one token from `ruleId`'s bucket.
   *
   * Returns `true` if a token was consumed (the caller may dispatch);
   * `false` if the bucket is empty (the caller is rate-limited and
   * MUST either queue or drop per the dispatch layer's policy).
   *
   * Lazy-refills the bucket first, so a long-idle rule will see a
   * full burst on its next call without any background timer.
   */
  tryAcquire(ruleId: string): boolean {
    const bucket = this.refillBucket(ruleId);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Inspect `ruleId`'s remaining tokens. Lazy-refills first, so the
   * returned value reflects the current observable budget.
   *
   * Used by tests for assertions and by metrics (a future `--metrics`
   * exporter) — production hot path uses `tryAcquire` only.
   */
  remaining(ruleId: string): number {
    return this.refillBucket(ruleId).tokens;
  }

  /**
   * Drop every per-rule bucket so the next `tryAcquire` starts cold
   * (i.e. with a full burst-capacity worth of tokens). Test helper —
   * production never calls this.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Resolve `ruleId`'s bucket, lazily creating it (full) on first
   * use and lazy-refilling it on every subsequent access.
   *
   * New buckets start full so a cold rule can immediately fire a
   * burst — that's the documented behaviour ("default 60 per minute"
   * means "up to 60 right now, then refill at 60/min").
   */
  private refillBucket(ruleId: string): Bucket {
    const now = this.now();
    const existing = this.buckets.get(ruleId);
    if (existing === undefined) {
      const bucket: Bucket = { tokens: this.burstCapacity, lastRefillMs: now };
      this.buckets.set(ruleId, bucket);
      return bucket;
    }
    const elapsed = now - existing.lastRefillMs;
    if (elapsed > 0) {
      // Lazy refill. Cap at burstCapacity so a long idle doesn't
      // accumulate an unbounded credit.
      const refilled = existing.tokens + elapsed * this.refillPerMs;
      existing.tokens = refilled > this.burstCapacity ? this.burstCapacity : refilled;
      existing.lastRefillMs = now;
    }
    return existing;
  }
}
